"""Resolve desktop and mobile share pages without executing page scripts."""
import html
import json
import re
from urllib.parse import urlparse, unquote

HOSTS = {'live.douyin.com', 'v.douyin.com', 'webcast.amemv.com', 'webcast.iesdouyin.com'}

def checked_url(url):
    p = urlparse(url)
    if p.scheme not in ('https', 'http') or p.hostname not in HOSTS or p.username or p.password or p.port:
        raise RuntimeError('INVALID_LINK')
    return url

def page_room(body):
    documents = []
    # React streaming data consists of JSON string chunks, sometimes split between scripts.
    chunks = []
    for raw in re.findall(r'self\.__rsc_f\.push\((\[.*?)\)\s*</script>', body, re.S):
        try:
            item = json.loads(raw)
            if len(item) > 1 and isinstance(item[1], str):
                chunks.append(item[1])
        except (ValueError, TypeError):
            continue
    for line in chunks + [''.join(chunks)]:
        try:
            documents.append(json.loads(line.split(':', 1)[1]))
        except (ValueError, IndexError):
            continue
    for raw in re.findall(r'<script[^>]*>(.*?)</script>', body, re.S):
        try:
            documents.append(json.loads(unquote(html.unescape(raw))))
        except ValueError:
            continue
    def walk(value):
        if isinstance(value, dict):
            room = value.get('room')
            if isinstance(room, dict):
                rid = room.get('idStr') or room.get('id_str') or room.get('roomIdStr') or room.get('id')
                if rid and re.fullmatch(r'[0-9]{1,20}', str(rid)):
                    return str(rid), room.get('status')
            for child in value.values():
                found = walk(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = walk(child)
                if found:
                    return found
    for document in documents:
        found = walk(document)
        if found:
            return found
    plain = html.unescape(body).replace(chr(92) + chr(34), chr(34))
    for key in ('roomIdStr', 'roomId', 'room_id'):
        match = re.search(r'"' + key + r'"[ ]*:[ ]*"?([0-9]{1,20})(?:"|[,}])', plain)
        if match:
            return match[1], None
    return None, None

def resolve_room(session, room):
    session.get('https://live.douyin.com/', timeout=(4, 6)).raise_for_status()
    url = 'https://live.douyin.com/' + room if re.fullmatch(r'[0-9]{1,20}', room) else checked_url(room)
    # Check each redirect before requesting it, and keep the same cookie session.
    for _ in range(8):
        response = session.get(checked_url(url), timeout=(5, 8), allow_redirects=False)
        response.raise_for_status()
        if response.status_code in (301, 302, 303, 307, 308):
            from urllib.parse import urljoin
            url = checked_url(urljoin(url, response.headers.get('Location', '')))
            continue
        response.encoding = 'utf-8'
        body = response.text
        rid, status = page_room(body)
        if str(status) in ('3', '4'):
            raise RuntimeError('OFFLINE')
        if rid:
            return rid
        if any(text in body for text in ('直播已结束', '尚未开播', '暂未开播', '直播结束')):
            raise RuntimeError('OFFLINE')
        raise RuntimeError('ROOM_UNAVAILABLE')
    raise RuntimeError('TOO_MANY_REDIRECTS')
