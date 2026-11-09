import unittest,json
from room_resolver import page_room,resolve_room,checked_url
class RoomTests(unittest.TestCase):
 def page(self,room):
  payload='5:'+json.dumps(['$',None,{'data':{'room':room}}])
  return '<script>self.__rsc_f.push('+json.dumps([1,payload])+')</script>'
 def test_exact_share_id(self):
  self.assertEqual(page_room(self.page({'id':7701657736241073000,'idStr':'7701657736241072905','status':2})),('7701657736241072905',2))
 def test_desktop_escaped(self):
  self.assertEqual(page_room(json.dumps({'roomId':'7701657736241072905'})),('7701657736241072905',None))
 def test_offline(self):
  body=self.page({'idStr':'7701657736241072905','status':4})
  class Reply:
   status_code=200;headers={};text=body
   def raise_for_status(self):pass
  class Session:
   def get(self,*args,**kwargs):return Reply()
  with self.assertRaisesRegex(RuntimeError,'OFFLINE'):resolve_room(Session(),'123456')
 def test_redirect_host(self):
  with self.assertRaisesRegex(RuntimeError,'INVALID_LINK'):checked_url('https://v.douyin.com.evil.test/123/')
if __name__=='__main__':unittest.main()
