import unittest
from unittest.mock import patch
import requests
import os,threading,socket,base64,hashlib
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
import websocket
from worker import Receiver

class NetworkTests(unittest.TestCase):
 def test_default_session_ignores_broken_system_proxy(self):
  with patch('worker.getproxies',return_value={'https':'http://127.0.0.1:1'}):
   receiver=Receiver({'room':'123'})
  self.assertFalse(receiver.session.trust_env)
  self.assertEqual(receiver.session.proxies,{})
  self.assertEqual(receiver.websocket_options()['http_no_proxy'],['*'])

 def test_explicit_system_proxy_available_and_can_fallback(self):
  with patch('worker.getproxies',return_value={'https':'http://127.0.0.1:1'}):
   receiver=Receiver({'room':'123','networkMode':'auto'})
  receiver.network_failed(requests.exceptions.ConnectionError('direct failed'))
  self.assertEqual(receiver.transport,'system')
  self.assertEqual(receiver.websocket_options()['http_proxy_port'],1)
  receiver.network_failed(requests.exceptions.ProxyError('bad proxy'))
  self.assertEqual(receiver.transport,'direct')
  self.assertEqual(receiver.websocket_options()['http_no_proxy'],['*'])

 def test_direct_mode_never_switches_to_broken_proxy(self):
  with patch('worker.getproxies',return_value={'https':'http://127.0.0.1:1'}):
   receiver=Receiver({'room':'123','networkMode':'direct'})
  receiver.network_failed(requests.exceptions.ConnectionError())
  self.assertEqual(receiver.transport,'direct')

 def test_real_http_and_websocket_bypass_broken_environment_proxy(self):
  class Handler(BaseHTTPRequestHandler):
   def do_GET(self):
    self.send_response(200);self.end_headers();self.wfile.write(b'local ok')
   def log_message(self,*args):pass
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
  listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(1);listener.settimeout(5);errors=[]
  def handshake():
   try:
    connection,_=listener.accept()
    with connection:
     connection.settimeout(5);data=b''
     while b'\r\n\r\n' not in data:data+=connection.recv(4096)
     headers={line.split(':',1)[0].lower():line.split(':',1)[1].strip() for line in data.decode().split('\r\n')[1:] if ':' in line}
     key=base64.b64encode(hashlib.sha1((headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
     connection.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+key+'\r\n\r\n').encode()+b'\x81\x02ok')
     connection.recv(4096)
   except Exception as error:errors.append(error)
  thread=threading.Thread(target=handshake,daemon=True);thread.start()
  proxies={'HTTP_PROXY':'http://127.0.0.1:1','HTTPS_PROXY':'http://127.0.0.1:1','NO_PROXY':'','http_proxy':'http://127.0.0.1:1','https_proxy':'http://127.0.0.1:1','no_proxy':''}
  try:
   with patch.dict(os.environ,proxies),patch('worker.getproxies',return_value={'https':'http://127.0.0.1:1'}):
    receiver=Receiver({'room':'123','networkMode':'direct'})
    self.assertEqual(receiver.session.get('http://127.0.0.1:'+str(server.server_port),timeout=2).text,'local ok')
    ws=websocket.create_connection('ws://127.0.0.1:'+str(listener.getsockname()[1]),timeout=2,**receiver.websocket_options())
    self.assertEqual(ws.recv(),'ok');ws.close()
   thread.join(2);self.assertEqual(errors,[])
  finally:server.shutdown();server.server_close();listener.close()

if __name__=='__main__':unittest.main()
