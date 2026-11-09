"""通过 stdin JSON 接收文本，不经过 shell 插值。输出 UTF-8 JSON。"""
import asyncio
import json
import sys
import os
from pathlib import Path
from urllib.request import getproxies
import edge_tts

async def main():
    request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    if request.get('action') == 'check':
        return {'ok': True, 'provider': 'edge-neural'}
    voice = request['voice']
    voices = json.loads((Path(__file__).resolve().parent.parent / 'voices.json').read_text(encoding='utf-8'))
    if voice not in {item['id'] for item in voices}:
        raise ValueError('不支持的音色')
    rate = int(request.get('rate', 0)) * 8
    pitch = int(request.get('pitch', 6))
    # aiohttp does not automatically read Windows system proxy settings.
    proxy = os.environ.get('AI_TTS_PROXY') or getproxies().get('https')
    target = request['output']
    temporary = target + '.part'
    # A failed system proxy must not consume the only retry for direct TTS.
    attempts = 3
    wait_seconds = 6 if request.get('interactive') else 9
    for attempt in range(attempts):
        try:
            # 系统代理不可用时第二次改为本请求直连，不修改Windows代理。
            selected_proxy = proxy if attempt == 0 else None
            communicate = edge_tts.Communicate(request['text'], voice, proxy=selected_proxy, rate=f'{rate:+d}%', pitch=f'{pitch:+d}Hz', connect_timeout=4, receive_timeout=5)
            await asyncio.wait_for(communicate.save(temporary), timeout=wait_seconds)
            os.replace(temporary, target)
            break
        except Exception:
            if os.path.exists(temporary):
                os.remove(temporary)
            if attempt == attempts - 1:
                raise RuntimeError('在线语音连接失败，已重试；请检查网络和语音输出状态')
            await asyncio.sleep(.3 * (attempt + 1))
    return {'ok': True, 'voice': voice}

if __name__ == '__main__':
    try:
        sys.stdout.buffer.write(json.dumps(asyncio.run(main()), ensure_ascii=False).encode('utf-8'))
    except Exception as exc:
        sys.stderr.buffer.write(str(exc).encode('utf-8'))
        sys.exit(1)
