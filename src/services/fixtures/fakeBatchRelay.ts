/** Test relay with three independently switchable client stores. */
export class FakeBatchRelay {
  rooms=new Map<string,Map<string,any>>();
  failBefore=false;loseAcknowledgement=false;uploads:string[]=[];
  handle(method:string,url:string,body?:string) {
    const parsed=new URL(url),parts=parsed.pathname.split('/').filter(Boolean),room=parts[2];
    const response=(status:number,value:unknown)=>({ok:status>=200 && status<300,status,text:async()=>JSON.stringify(value)});
    if(parts[0]!=='v2') return response(404,{});
    if(!this.rooms.has(room)) this.rooms.set(room,new Map());
    const records=this.rooms.get(room)!;
    if(method==='PUT') {
      this.uploads.push(body!);
      if(this.failBefore) return response(503,{});
      const id=parts[4],blob=JSON.parse(body!);
      if(records.has(id) && (records.get(id).ct!==blob.ct || records.get(id).nonce!==blob.nonce)) return response(409,{});
      if(!records.has(id)) records.set(id,{...blob,batch_id:id,cursor:records.size+1});
      if(this.loseAcknowledgement) {this.loseAcknowledgement=false;throw new Error('connection lost after durable write');}
      return response(200,{batch_id:id,cursor:records.get(id).cursor,durable:true});
    }
    if(parts[3]==='version' || parts[3]==='poll') return response(200,{version:records.size});
    const after=Number(parsed.searchParams.get('after') ?? 0),batches=[...records.values()].filter(r=>r.cursor>after).slice(0,200);
    return response(200,{batches,cursor:batches[batches.length-1]?.cursor ?? after});
  }
}
export class DeviceStorage {
  data=new Map<string,string>();
  getItem(key:string){return this.data.get(key) ?? null;}
  setItem(key:string,value:string){this.data.set(key,String(value));}
  removeItem(key:string){this.data.delete(key);}
  clear(){this.data.clear();}
}
