export async function post(url,data={}) {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(240000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败');return result;
}
export function connect(callback,onConnection=()=>{}) {
  const stream=new EventSource('/api/events');stream.onopen=()=>onConnection(true);stream.onerror=()=>onConnection(false);
  stream.onmessage=event=>{try{callback(JSON.parse(event.data));}catch(error){console.error(error);}};return stream;
}
