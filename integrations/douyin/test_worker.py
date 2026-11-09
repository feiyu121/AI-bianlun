import unittest
from worker import message_event
from protobuf.douyin import ChatMessage,GiftMessage,GiftStruct,LikeMessage,Common,User
class ProtocolTests(unittest.TestCase):
 def test_chat(self):
  m=ChatMessage(common=Common(msg_id=9007199254740993,create_time=1793180000),user=User(id=9007199254740995,nick_name='测试观众'),content='你叫什么名字')
  e=message_event('WebcastChatMessage',bytes(m),0,'123');self.assertEqual(e['id'],'9007199254740993');self.assertEqual(e['userId'],'9007199254740995');self.assertEqual(e['text'],'你叫什么名字')
 def test_gift(self):
  m=GiftMessage(common=Common(msg_id=77),user=User(id=9,nick_name='小明'),gift_id=19,gift=GiftStruct(name='墨镜',combo=True),group_id=51,repeat_count=5,repeat_end=1)
  e=message_event('WebcastGiftMessage',bytes(m),77,'123');self.assertEqual(e['giftName'],'墨镜');self.assertEqual(e['repeatCount'],5);self.assertTrue(e['combo']);self.assertEqual(e['groupId'],'51')
 def test_likes(self):
  m=LikeMessage(user=User(id=9,nick_name='小明'),count=10)
  self.assertEqual(message_event('WebcastLikeMessage',bytes(m),8,'123')['count'],10)
if __name__=='__main__':unittest.main()
