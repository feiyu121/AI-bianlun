"""JSONL Douyin receiver. AGPL-3.0; upstream protocol/signature attribution in NOTICE.md."""
import sys,json,gzip,time,threading,hashlib,re,random,os
from pathlib import Path
from urllib.parse import urlencode,urlparse,parse_qs
from urllib.request import getproxies
sys.path.insert(0,str(Path(__file__).parent))
sys.path.insert(0,str(Path(__file__).parent/'vendor'))
import requests,websocket
from py_mini_racer import MiniRacer
from protobuf.douyin import PushFrame,Response,ChatMessage,GiftMessage,LikeMessage,ControlMessage,MemberMessage
from room_resolver import resolve_room
LOCK=threading.Lock()
def emit(kind,**data):
 with LOCK:
  sys.stdout.write(json.dumps({'kind':kind,**data},ensure_ascii=False)+'\n');sys.stdout.flush()
def message_event(method,payload,outer_id,room):
 cls={'WebcastChatMessage':ChatMessage,'WebcastGiftMessage':GiftMessage,'WebcastLikeMessage':LikeMessage,'WebcastMemberMessage':MemberMessage}.get(method)
 if not cls:return None
 m=cls().parse(payload);u=m.user
 event={'id':str(outer_id or m.common.msg_id),'room':str(room),'name':u.nick_name,'userId':str(u.id),'timestamp':m.common.create_time}
 if method=='WebcastMemberMessage':
  if m.action not in (0,1):return None
  event.update(type='enter')
 elif method=='WebcastChatMessage':event.update(type='comment',text=m.content)
 elif method=='WebcastLikeMessage':event.update(type='like',count=max(1,m.count))
 else:event.update(type='gift',giftId=str(m.gift_id),giftName=m.gift.name,groupId=str(m.group_id),combo=bool(m.gift.combo),repeatCount=max(1,m.repeat_count or m.combo_count or m.group_count),repeatEnd=bool(m.repeat_end))
 return event
class Receiver:
 def __init__(self,config):
  self.config=config;self.room=config['room'];self.session=requests.Session();self.session.trust_env=False;self.system_proxies=getproxies();self.network_mode=config.get('networkMode','auto');self.transport='system' if self.network_mode=='system' else 'direct';self.apply_transport();self.stopping=threading.Event();self.ws=None;self.opened_at=0;self.last_frame=0;self.last_error=None
  self.ua='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  self.session.headers.update({'User-Agent':self.ua})
  if config.get('cookie'):
   for pair in config['cookie'].split(';'):
    if '=' in pair:
     k,v=pair.strip().split('=',1);self.session.cookies.set(k,v,domain='.douyin.com')
 def apply_transport(self):
  # 不改用户Windows代理；仅本进程直连抖音，防止关闭代理软件后残留127.0.0.1端口使直播失联。
  self.session.proxies.clear()
  # websocket-client 1.x 在没有显式proxy_host时会忽略http_no_proxy参数；必须同时设置接收子进程环境。
  # 仅影响独立Python接收进程，不修改Windows注册表或主程序的API/TTS代理。
  os.environ['no_proxy']='*' if self.transport=='direct' else ''
  os.environ['NO_PROXY']=os.environ['no_proxy']
  if self.transport=='system':
   for scheme in ('http','https'):
    proxy=self.system_proxies.get(scheme) or self.system_proxies.get('all')
    if proxy:self.session.proxies[scheme]=proxy if '://' in proxy else 'http://'+proxy
 def network_failed(self,error):
  if self.network_mode=='auto':
   if self.transport=='system':self.transport='direct'
   elif self.system_proxies.get('https') or self.system_proxies.get('all'):self.transport='system'
   self.apply_transport()
 def websocket_options(self):
  if self.transport=='direct':return {'http_no_proxy':['*']}
  proxy=self.system_proxies.get('https') or self.system_proxies.get('http') or self.system_proxies.get('all') or ''
  proxy=urlparse(proxy if '://' in proxy else 'http://'+proxy)
  if not proxy.hostname:return {'http_no_proxy':['*']}
  from urllib.parse import unquote
  options={'http_proxy_host':proxy.hostname,'http_proxy_port':proxy.port or 80,'proxy_type':proxy.scheme or 'http','http_no_proxy':[]}
  if proxy.username:options['http_proxy_auth']=(unquote(proxy.username),unquote(proxy.password or ''))
  return options
 def resolve(self):
  return resolve_room(self.session,self.room)
 def signature(self,url):
  q=parse_qs(urlparse(url).query,keep_blank_values=True)
  keys='live_id,aid,version_code,webcast_sdk_version,room_id,sub_room_id,sub_channel_id,did_rule,user_unique_id,device_platform,device_type,ac,identity'.split(',')
  digest=hashlib.md5(','.join(k+'='+q.get(k,[''])[0] for k in keys).encode()).hexdigest()
  with MiniRacer() as js:
   js.eval((Path(__file__).parent/'vendor/sign.js').read_text(encoding='utf-8'))
   return js.call('get_sign',digest)
 def heartbeat(self,ws,done):
  while not done.wait(5):
   try:ws.send(bytes(PushFrame(payload_type='hb')),websocket.ABNF.OPCODE_PING);emit('health',transport=self.transport)
   except Exception:return
 def connect_once(self):
  self.last_error=None;self.opened_at=0
  room_id=self.resolve();stamp=int(time.time()*1000);did=str(random.randrange(7300000000000000000,7400000000000000000))
  params={'app_name':'douyin_web','version_code':'180800','webcast_sdk_version':'1.0.14-beta.0','update_version_code':'1.0.14-beta.0','compress':'gzip','device_platform':'web','cookie_enabled':'true','screen_width':'1536','screen_height':'864','browser_language':'zh-CN','browser_platform':'Win32','browser_name':'Mozilla','browser_version':self.ua[8:],'browser_online':'true','tz_name':'Asia/Shanghai','cursor':f'd-1_u-1_fh-0_t-{stamp}_r-1','internal_ext':f'internal_src:dim|wss_push_room_id:{room_id}|wss_push_did:{did}|first_req_ms:{stamp}|fetch_time:{stamp}|seq:1|wss_info:0-{stamp}-0-0|wrds_v:0','host':'https://live.douyin.com','aid':'6383','live_id':'1','did_rule':'3','endpoint':'live_pc','support_wrds':'1','user_unique_id':did,'im_path':'/webcast/im/fetch/','identity':'audience','need_persist_msg_count':'0','room_id':room_id,'heartbeatDuration':'0'}
  url='wss://webcast100-ws-web-lq.douyin.com/webcast/im/push/v2/?'+urlencode(params)
  url+='&signature='+self.signature(url);done=threading.Event()
  cookie='; '.join(k+'='+v for k,v in self.session.cookies.get_dict().items())
  def opened(ws):
   self.opened_at=time.monotonic();self.last_frame=self.opened_at
   emit('status',state='connected',message='已连接抖音直播间 · '+('直连' if self.transport=='direct' else '系统代理'),roomId=room_id,transport=self.transport)
   threading.Thread(target=self.heartbeat,args=(ws,done),daemon=True).start()
  def received(ws,raw):
   self.last_frame=time.monotonic()
   try:
    frame=PushFrame().parse(raw)
    if not frame.payload:return
    payload=gzip.decompress(frame.payload) if frame.payload[:2]==b'\x1f\x8b' else frame.payload
    response=Response().parse(payload)
    if response.need_ack:ws.send(bytes(PushFrame(log_id=frame.log_id,payload_type='ack',payload=response.internal_ext.encode())),websocket.ABNF.OPCODE_BINARY)
    for item in response.messages_list:
     if item.method=='WebcastControlMessage' and ControlMessage().parse(item.payload).status==3:
      emit('status',state='offline',message='主播已下播，等待重新开播');ws.close();continue
     event=message_event(item.method,item.payload,item.msg_id,self.room)
     if event:emit('event',event=event)
   except Exception as error:emit('warning',message='平台消息解析失败：'+type(error).__name__)
  def failed(ws,error):self.last_error=error;emit('warning',message='直播链路断开，正在重连：'+type(error).__name__)
  def pong(ws,data):self.last_frame=time.monotonic()
  self.ws=websocket.WebSocketApp(url,header={'Cookie':cookie,'User-Agent':self.ua},on_open=opened,on_message=received,on_pong=pong,on_error=failed,on_close=lambda *args:done.set())
  self.last_frame=time.monotonic()
  def watch():
   while not done.wait(5):
    if time.monotonic()-self.last_frame>65:
     self.last_error=TimeoutError('直播链路心跳超时');self.ws.close();return
  threading.Thread(target=watch,daemon=True).start()
  websocket.setdefaulttimeout(10)
  try:self.ws.run_forever(ping_interval=20,ping_timeout=10,**self.websocket_options())
  finally:done.set()
  if self.last_error:raise self.last_error
 def run(self):
  attempt=0
  while not self.stopping.is_set():
   emit('status',state='connecting' if attempt==0 else 'reconnecting',message='正在连接抖音直播间 · '+('直连' if self.transport=='direct' else '系统代理'),transport=self.transport,attempt=attempt)
   try:self.connect_once()
   except Exception as error:
    code=str(error)
    known={'OFFLINE':'直播间尚未开播，稍后自动重试','ROOM_UNAVAILABLE':'暂未取得直播间信息，请确认分享的是直播间；若平台要求登录，可填写 Cookie','TOO_MANY_REDIRECTS':'直播分享链接跳转过多，请重新复制直播间链接'}
    if code not in known and isinstance(error,(requests.exceptions.RequestException,websocket.WebSocketException,ConnectionError,TimeoutError,OSError)):
     self.network_failed(error)
    message=known.get(code,'连接失败：'+type(error).__name__+'；将使用'+('直连' if self.transport=='direct' else '系统代理')+'自动重试')
    emit('status',state='offline' if code=='OFFLINE' else 'reconnecting',message=message,transport=self.transport,attempt=attempt+1)
   if self.opened_at and time.monotonic()-self.opened_at>30:attempt=0
   attempt+=1;delay=min(15,2**min(attempt,4));emit('retry',seconds=delay,transport=self.transport);self.stopping.wait(delay)
if __name__=='__main__':
 try:
  config=json.loads(sys.stdin.readline())
  if config.get('action')=='check':
   with MiniRacer() as js:
    js.eval((Path(__file__).parent/'vendor/sign.js').read_text(encoding='utf-8'));assert js.call('get_sign','0'*32)
   emit('ready',message='抖音依赖与签名组件正常')
  else:Receiver(config).run()
 except Exception as error:
  emit('status',state='error',message='接入进程启动失败：'+type(error).__name__);sys.exit(1)
