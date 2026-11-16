#!/usr/bin/env python3
"""Optional local Scrapling worker (ENABLE_SCRAPLING must be exactly "true").

Fetches public pages only on the lead's recorded official domain and prints a
JSON report consumed by packages/server/scrapling-adapter.ts. This worker never
uses stealth/anti-bot features, proxies, CAPTCHA solving, logins or search
engines; it cannot bypass robots.txt, rate limits or host policy. Contact
extraction happens in TypeScript from the returned page text, so this process
stays a guarded fetcher/parser, not a decision maker.

Modes:
  --plan job.json             validate the job and print the bounded fetch plan
                              (no network, no scrapling import)
  --from-html job.json f...   parse local HTML fixtures into a report
  --fetch job.json            fetch planned pages (requires scrapling[fetchers])

Exit codes: 0 ok, 2 SCRAPLING_DISABLED, 3 SCRAPLING_UNAVAILABLE,
4 SCRAPLING_SSRF_BLOCKED, 5 SCRAPLING_JOB_INVALID, 6 SCRAPLING_NOT_PERMITTED.
"""
import argparse
import ipaddress
import json
import re
import socket
import sys
import time
import uuid as uuidlib
from datetime import datetime, timezone
from urllib.parse import urlparse

MAX_PAGES = 6
MAX_SEEDS = 6
DELAY_SECONDS = 2.0
TIMEOUT_SECONDS = 15
MAX_TEXT = 100000
USER_AGENT = "chaincraft-intake-worker"

EXIT_DISABLED = 2
EXIT_UNAVAILABLE = 3
EXIT_SSRF = 4
EXIT_INVALID = 5
EXIT_NOT_PERMITTED = 6


def fail(code, message):
    print(message, file=sys.stderr)
    sys.exit(code)


def host_of(url):
    return urlparse(url).hostname or ""


def official_host(url):
    return host_of(url).lower().removeprefix("www.")


def check_host(host):
    """Syntactic SSRF guard; DNS resolution is re-checked before fetching."""
    name = (host or "").lower().rstrip(".")
    if not name or name == "localhost" or name.endswith((".local", ".internal", ".localhost", ".home")):
        return "SSRF_BLOCKED_HOST"
    try:
        address = ipaddress.ip_address(name.strip("[]"))
    except ValueError:
        return None  # Domain name: resolved and re-checked in fetch mode.
    if (address.is_private or address.is_loopback or address.is_link_local
            or address.is_reserved or address.is_unspecified):
        return "SSRF_BLOCKED_ADDRESS"
    return None


def load_job(path):
    try:
        with open(path, encoding="utf-8") as handle:
            job = json.load(handle)
    except (OSError, ValueError):
        fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
    if not isinstance(job, dict):
        fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
    try:
        uuidlib.UUID(str(job["lead_id"]))
        name = str(job["business_name"]).strip()
        official = str(job["official_url"])
    except (KeyError, ValueError, TypeError):
        fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
    if not 2 <= len(name) <= 100:
        fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
    seeds = job.get("seed_urls") or [official]
    if not isinstance(seeds, list) or not 1 <= len(seeds) <= MAX_SEEDS:
        fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
    plan = []
    origin = official_host(official)
    for seed in seeds:
        if not isinstance(seed, str) or len(seed) > 2000:
            fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
        parsed = urlparse(seed)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            fail(EXIT_INVALID, "SCRAPLING_SCHEME_NOT_ALLOWED")
        if parsed.port not in (None, 443):
            fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
        blocked = check_host(parsed.hostname)
        if blocked:
            fail(EXIT_SSRF, blocked)
        if official_host(seed) != origin:
            fail(EXIT_NOT_PERMITTED, "SCRAPLING_OFF_DOMAIN_URL")
        if seed not in plan:
            plan.append(seed)
    return {"lead_id": str(job["lead_id"]), "business_name": name, "official_url": official,
            "seeds": plan[:MAX_PAGES], "page_urls": [str(u) for u in job.get("page_urls", [])][:MAX_PAGES]}


def print_plan(job):
    print(json.dumps({"pages": job["seeds"], "delay_seconds": DELAY_SECONDS,
                      "timeout_seconds": TIMEOUT_SECONDS, "max_pages": MAX_PAGES,
                      "max_text": MAX_TEXT, "robots_txt_obey": True}))


def robots_permits(text, path, user_agent=USER_AGENT):
    groups, agents, rules = [], [], []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        field, _, value = line.partition(":")
        field, value = field.strip().lower(), value.strip()
        if field == "user-agent":
            if rules and agents:
                groups.append((agents, rules))
                agents, rules = [], []
            agents.append(value)
        elif field in ("allow", "disallow") and value:
            rules.append((field, value))
    if agents:
        groups.append((agents, rules))
    selected = next((rules for a, rules in groups if user_agent in a), None)
    if selected is None:
        selected = next((rules for a, rules in groups if "*" in a), [])
    best_field, best_len = "allow", -1
    for field, value in selected:
        if path.startswith(value) and len(value) > best_len:
            best_field, best_len = field, len(value)
    return best_field != "disallow"


def resolve_public(host):
    """Fail closed: an unresolvable or non-public host never gets requested."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        fail(EXIT_SSRF, "SSRF_DNS_FAILED")
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0].split("%")[0])
        except ValueError:
            continue
        if (address.is_private or address.is_loopback or address.is_link_local
                or address.is_reserved or address.is_unspecified):
            fail(EXIT_SSRF, "SSRF_DNS_BLOCKED")


def extract(html, url, observed_at, status, discovered_from):
    try:
        from scrapling.parser import Selector
    except ImportError:
        fail(EXIT_UNAVAILABLE, "SCRAPLING_UNAVAILABLE")
    page = Selector(html)
    title = (page.css("title::text").get() or "").strip()[:300]
    body = page.css("body").get() or html
    return {"url": url, "title": title, "observed_at": observed_at,
            "text": body[:MAX_TEXT], "http_status": status,
            "discovered_from": discovered_from}


def fetch_pages(job, urls):
    try:
        from scrapling.fetchers import Fetcher
    except ImportError:
        fail(EXIT_UNAVAILABLE, "SCRAPLING_UNAVAILABLE")
    origin = job["official_url"].split("/", 3)[0]
    host = official_host(job["official_url"])
    resolve_public(host)
    try:
        robots = Fetcher.get(origin + "/robots.txt", timeout=TIMEOUT_SECONDS)
        robots_text = (getattr(robots, "text", None) or "") if getattr(robots, "status", 200) == 200 else ""
    except Exception:
        fail(EXIT_NOT_PERMITTED, "SCRAPLING_ROBOTS_UNAVAILABLE")
    pages, errors, discovered = [], [], []
    from urllib.parse import urljoin, urlparse as _parse
    for index, url in enumerate(urls):
        path = _parse(url).path or "/"
        if not robots_permits(robots_text, path):
            errors.append(f"robots disallowed {url}"[:300])
            continue
        if index:
            time.sleep(DELAY_SECONDS)
        try:
            # No stealth, no proxies, no CAPTCHA solving: plain permitted GET.
            response = Fetcher.get(url, timeout=TIMEOUT_SECONDS)
        except Exception as exc:  # Recorded, never retried in this invocation.
            errors.append(f"fetch failed {url}: {type(exc).__name__}"[:300])
            continue
        final = str(getattr(response, "url", url))
        if official_host(final) != host:
            errors.append(f"redirect left official domain: {url}"[:300])
            continue
        status = getattr(response, "status", None) or getattr(response, "status_code", None)
        html = (getattr(response, "html", None) or getattr(response, "text", None)
                or getattr(response, "content", b""))
        if isinstance(html, bytes):
            html = html.decode("utf-8", "replace")
        observed = datetime.now(timezone.utc).isoformat()
        pages.append(extract(html, final, observed, status if isinstance(status, int) else None, "seed"))
        try:
            from scrapling.parser import Selector
            for href in Selector(html).css("a::attr(href)").getall():
                absolute = urljoin(final, href.split("#")[0])
                if official_host(absolute) == host and re.search(r"/(contact|about|reach)", urlparse(absolute).path, re.I):
                    if absolute not in urls and absolute not in discovered:
                        discovered.append(absolute)
        except Exception:
            pass  # Link discovery is optional; page text already extracted.
    for link in discovered[: max(0, MAX_PAGES - len(pages))]:
        path = _parse(link).path or "/"
        if not robots_permits(robots_text, path):
            errors.append(f"robots disallowed {link}"[:300])
            continue
        time.sleep(DELAY_SECONDS)
        try:
            response = Fetcher.get(link, timeout=TIMEOUT_SECONDS)
        except Exception as exc:
            errors.append(f"fetch failed {link}: {type(exc).__name__}"[:300])
            continue
        final = str(getattr(response, "url", link))
        if official_host(final) != host:
            errors.append(f"redirect left official domain: {link}"[:300])
            continue
        status = getattr(response, "status", None) or getattr(response, "status_code", None)
        html = (getattr(response, "html", None) or getattr(response, "text", None)
                or getattr(response, "content", b""))
        if isinstance(html, bytes):
            html = html.decode("utf-8", "replace")
        observed = datetime.now(timezone.utc).isoformat()
        pages.append(extract(html, final, observed, status if isinstance(status, int) else None, "link"))
    return pages, errors


def emit_report(job, pages, errors):
    now = datetime.now(timezone.utc).isoformat()
    print(json.dumps({"scraper": "scrapling", "lead_id": job["lead_id"],
                      "business_name": job["business_name"], "official_url": job["official_url"],
                      "fetched_at": now, "pages": pages, "errors": errors[:10]}))


def main():
    parser = argparse.ArgumentParser(description="Optional local Scrapling worker")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", action="store_true")
    mode.add_argument("--fetch", action="store_true")
    mode.add_argument("--from-html", action="store_true")
    parser.add_argument("job", help="Path to the job JSON file")
    parser.add_argument("files", nargs="*", help="HTML fixture files for --from-html")
    args = parser.parse_args()

    if __import__("os").environ.get("ENABLE_SCRAPLING") != "true":
        fail(EXIT_DISABLED, "SCRAPLING_DISABLED")
    job = load_job(args.job)
    if args.plan:
        print_plan(job)
        return
    if args.from_html:
        if not args.files:
            fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
        pages, errors = [], []
        urls = job["page_urls"] or [job["official_url"]] * len(args.files)
        if len(urls) < len(args.files):
            fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
        observed = datetime.now(timezone.utc).isoformat()
        for path, url in zip(args.files, urls):
            try:
                with open(path, encoding="utf-8") as handle:
                    html = handle.read(MAX_TEXT * 4)
            except OSError:
                fail(EXIT_INVALID, "SCRAPLING_JOB_INVALID")
            if official_host(url) != official_host(job["official_url"]):
                fail(EXIT_NOT_PERMITTED, "SCRAPLING_OFF_DOMAIN_URL")
            pages.append(extract(html, url, observed, None, "seed"))
        emit_report(job, pages, [])
        return
    pages, errors = fetch_pages(job, job["seeds"])
    if not pages and not errors:
        fail(EXIT_NOT_PERMITTED, "SCRAPLING_NOT_PERMITTED")
    emit_report(job, pages, errors)


if __name__ == "__main__":
    main()
