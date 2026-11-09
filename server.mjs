import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApplication} from './lib/http-app.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||4320);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT 需要为 1024～65535 的整数');
const app=await createApplication({root,dataDir:path.resolve(process.env.AI_DATA_DIR||path.join(root,'data'))});
app.server.on('error',error=>{console.error('启动失败：'+error.message);process.exitCode=1;app.close();});
app.server.listen(port,'127.0.0.1',()=>{console.log(`AI 辩论工作台已启动：http://127.0.0.1:${port}`);console.log(`OBS 场景：http://127.0.0.1:${port}/scene.html`);});
let closing=false;
async function shutdown(){if(closing)return;closing=true;await app.close();process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
