#!/usr/bin/env python3
"""Send a maintainer email when the Zhaopin login cookie stops working.

The collect workflow writes a status JSON file after every run. This script
reads that file, applies a cooldown, and sends a plain-text alert through SMTP.

Required environment:
  SMTP_USERNAME        SMTP account, e.g. a QQ Mail address
  SMTP_PASSWORD        SMTP authorization code (never commit this)
  ALERT_EMAIL_TO       Recipient; defaults to SMTP_USERNAME
  TODAYJOB_STATUS_FILE Path to the collect status JSON

Optional environment:
  SMTP_HOST            Default: smtp.qq.com
  SMTP_PORT            Default: 465
  ALERT_STATE_FILE     Default: .todayjob/cookie-alert.json
  ALERT_COOLDOWN_DAYS  Default: 3
  RUN_URL              Link to the workflow run, included in the email
  COOKIE_HELPER_URL    Default: https://todayjob.vercel.app/cookie/
  REPO                 Default: auulb/todayJob
"""

from __future__ import annotations

import json
import os
import smtplib
import ssl
import sys
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo


SHANGHAI = ZoneInfo("Asia/Shanghai")
DEFAULT_STATE_FILE = Path(".todayjob/cookie-alert.json")
DEFAULT_STATUS_FILE = Path(".todayjob/last-run.json")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def read_status() -> dict:
    path = Path(env("TODAYJOB_STATUS_FILE", str(DEFAULT_STATUS_FILE)))
    if not path.exists():
        raise SystemExit(f"status file not found: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def should_skip_for_cooldown(state_file: Path, cooldown_days: int) -> bool:
    if cooldown_days <= 0 or not state_file.exists():
        return False
    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
        last = datetime.fromisoformat(state["lastAlertAt"])
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
    except (KeyError, ValueError, json.JSONDecodeError, OSError) as exc:
        print(f"[alert] ignoring unreadable state file: {exc}")
        return False

    elapsed = datetime.now(timezone.utc) - last
    if elapsed < timedelta(days=cooldown_days):
        remaining = timedelta(days=cooldown_days) - elapsed
        print(
            "[alert] cooldown active; "
            f"last alert {last.isoformat()}, next in {remaining.total_seconds() / 3600:.1f}h"
        )
        return True
    return False


def build_message(status: dict, test: bool) -> tuple[str, str]:
    repo = env("REPO", "auulb/todayJob")
    helper_url = env("COOKIE_HELPER_URL", "https://todayjob.vercel.app/cookie/")
    secrets_url = f"https://github.com/{repo}/settings/secrets/actions"
    run_url = env("RUN_URL")
    now = datetime.now(SHANGHAI)
    date = status.get("date") or now.strftime("%Y-%m-%d")

    if test:
        subject = "[TodayJob] 邮件提醒测试"
        body = f"""这是一封 TodayJob 邮件提醒测试。

如果你收到这封邮件，说明 SMTP 配置正常；以后智联招聘 Cookie 失效时，
系统会向这个邮箱发送提醒。

测试时间：{now.strftime('%Y-%m-%d %H:%M:%S %Z')}
Cookie 小工具：{helper_url}
Secret 设置：{secrets_url}
"""
        return subject, body

    reason = status.get("cookieFallbackReason") or "未提供原因"
    subject = f"[TodayJob] 智联招聘 Cookie 需要更新（{date}）"
    body = f"""TodayJob 今日采集时发现智联招聘登录 Cookie 已失效或配置不完整。

日期：{date}
采集模式：匿名模式（每个关键词最多 100 条）
状态：{status.get('cookieStatus', 'unknown')}
原因：{reason}

影响：今天的岗位覆盖可能不完整。请重新生成 Cookie 并更新 Secret。

操作步骤：
1. 打开 Cookie 小工具：{helper_url}
2. 在智联招聘登录后，点击“生成 Cookie”书签
3. 复制 Cookie，更新 GitHub Secret：ZHAOPIN_COOKIE
   {secrets_url}

本次运行：{run_url or '（手动运行，无链接）'}

此提醒最多每 3 天发送一次；Cookie 更新成功后会停止。
"""
    return subject, body


def send_email(subject: str, body: str) -> None:
    host = env("SMTP_HOST", "smtp.qq.com")
    port = int(env("SMTP_PORT", "465"))
    username = env("SMTP_USERNAME")
    password = env("SMTP_PASSWORD")
    recipient = env("ALERT_EMAIL_TO") or username

    if not username or not password:
        raise SystemExit("SMTP_USERNAME and SMTP_PASSWORD are required")
    if not recipient:
        raise SystemExit("ALERT_EMAIL_TO or SMTP_USERNAME is required")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = username
    msg["To"] = recipient
    msg.set_content(body, charset="utf-8")

    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as smtp:
            smtp.login(username, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            smtp.login(username, password)
            smtp.send_message(msg)

    print(f"[alert] sent to {recipient}")


def main() -> int:
    test = "--test" in sys.argv
    dry_run = "--dry-run" in sys.argv
    try:
        status = read_status()
    except SystemExit:
        if not test:
            raise
        status = {}

    if not test and status.get("cookieStatus") not in {"expired", "invalid"}:
        print(f"[alert] cookie status is {status.get('cookieStatus')}; no email needed")
        return 0

    state_file = Path(env("ALERT_STATE_FILE", str(DEFAULT_STATE_FILE)))
    cooldown_days = int(env("ALERT_COOLDOWN_DAYS", "3"))
    if not test and should_skip_for_cooldown(state_file, cooldown_days):
        return 0

    subject, body = build_message(status, test)
    if dry_run:
        print(f"Subject: {subject}\n")
        print(body)
        return 0

    send_email(subject, body)

    if not test:
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state = {
            "lastAlertAt": datetime.now(timezone.utc).isoformat(),
            "lastAlertDate": datetime.now(SHANGHAI).strftime("%Y-%m-%d"),
            "cookieStatus": status.get("cookieStatus"),
            "runUrl": env("RUN_URL"),
        }
        state_file.write_text(
            json.dumps(state, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"[alert] state written to {state_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
