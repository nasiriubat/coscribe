from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .. import mail
from ..config import get_settings
from ..db import get_db
from ..deps import current_user, get_session
from ..llm.base import PURPOSES
from ..models import AuthSession, PasswordReset, Provider, PurposeAssignment, User, now
from ..schemas import ChangePasswordIn, ForgotIn, LoginIn, ResetIn, UpdateMeIn, UserOut
from ..security import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    hash_password,
    login_limiter,
    new_token,
    session_expiry,
    token_id,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
log = logging.getLogger("paperwriter.auth")
RESET_TTL = timedelta(hours=1)


def _set_cookies(response: Response, token: str, csrf: str) -> None:
    settings = get_settings()
    max_age = settings.session_ttl_hours * 3600
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        secure=settings.cookies_secure,
        path="/",
    )
    # Readable by JS on purpose: double-submit CSRF pattern.
    response.set_cookie(
        CSRF_COOKIE,
        csrf,
        max_age=max_age,
        httponly=False,
        samesite="lax",
        secure=settings.cookies_secure,
        path="/",
    )


@router.post("/login", response_model=UserOut)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    client = request.client.host if request.client else "unknown"
    if not login_limiter.allow(f"{client}:{body.email.lower()}"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Try again in a few minutes.")
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if not user or not user.is_active or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong email or password")
    token = new_token()
    csrf = new_token(24)
    sess = AuthSession(
        id=token_id(token),
        user_id=user.id,
        csrf_token=csrf,
        expires_at=session_expiry(),
        user_agent=(request.headers.get("user-agent") or "")[:255],
    )
    db.add(sess)
    db.commit()
    _set_cookies(response, token, csrf)
    return user


@router.post("/logout", status_code=204)
def logout(response: Response, sess: AuthSession | None = Depends(get_session), db: Session = Depends(get_db)):
    if sess:
        db.delete(sess)
        db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    return Response(status_code=204)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.get("/workspace")
def workspace(_: User = Depends(current_user), db: Session = Depends(get_db)):
    """Whether model jobs can run yet, so a member is told why nothing drafts instead of meeting errors."""
    ready = True
    for purpose in PURPOSES:
        a = db.get(PurposeAssignment, purpose)
        prov = db.get(Provider, a.provider_id) if a and a.provider_id else None
        if not (a and a.model and prov and prov.enabled):
            ready = False
            break
    admin = db.scalar(select(User).where(User.role == "admin", User.is_active.is_(True)).order_by(User.created_at))
    return {"ready": ready, "admin_name": admin.display_name if admin else None}


@router.patch("/me", response_model=UserOut)
def update_me(body: UpdateMeIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.display_name = body.display_name
    db.commit()
    return user


@router.post("/change-password", response_model=UserOut)
def change_password(body: ChangePasswordIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is wrong")
    if body.current_password == body.new_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "New password must differ from the current one")
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    db.commit()
    return user


# ------------------------------------------------------------------ forgot / reset


@router.post("/forgot", status_code=202)
def forgot_password(body: ForgotIn, request: Request, db: Session = Depends(get_db)):
    """Always answers the same way, so the form cannot be used to probe for accounts."""
    client = request.client.host if request.client else "unknown"
    if not login_limiter.allow(f"forgot:{client}"):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Try again in a few minutes.")
    if not mail.is_configured(db):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Password reset by email is not set up. Ask an administrator.")
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if user and user.is_active:
        db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id))
        token = new_token()
        db.add(PasswordReset(id=token_id(token), user_id=user.id, expires_at=now() + RESET_TTL))
        db.commit()
        subject, text = mail.reset_link(db, display_name=user.display_name, token=token)
        try:
            mail.send(db, user.email, subject, text)
        except mail.MailError as e:  # the user still sees the neutral answer
            log.warning("password reset mail failed for %s: %s", user.email, e)
    return {"ok": True}


@router.post("/reset", response_model=UserOut)
def reset_password(body: ResetIn, db: Session = Depends(get_db)):
    row = db.get(PasswordReset, token_id(body.token))
    if not row:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This link is not valid. Ask for a new one.")
    expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=now().tzinfo)
    if expires < now():
        db.delete(row)
        db.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This link has expired. Ask for a new one.")
    user = db.get(User, row.user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This link is not valid. Ask for a new one.")
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))  # sign out everywhere
    db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id))
    db.commit()
    return user
