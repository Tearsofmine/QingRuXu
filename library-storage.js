/* v3 atomic/differential storage. Old v2 clients cannot open this DB version. */
globalThis.QrxLibrary = (() => {
  const NAME='qingruxu-library-db', VERSION=3, STORES=['books','meta','records','chapter-texts','reading-state','book-revisions'];
  const STATE=['progress','readingPosition','lastReadAt','bookmarks'];
  let baseline=new Map(), deleted=new Set(), adopted=false, listener=()=>{};
  const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('qingruxu-library-v3'):null;
  if(channel)channel.onmessage=()=>listener();
  function error(code){return Object.assign(new Error(code),{code});}
  function open(){return new Promise((resolve,reject)=>{
    const r=indexedDB.open(NAME,VERSION);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(error('database-blocked'));
    r.onupgradeneeded=()=>{const d=r.result;for(const name of ['records','meta'])if(!d.objectStoreNames.contains(name))d.createObjectStore(name);
      if(!d.objectStoreNames.contains('books'))d.createObjectStore('books',{keyPath:'id'});
      if(!d.objectStoreNames.contains('chapter-texts')){const s=d.createObjectStore('chapter-texts',{keyPath:['bookId','index']});s.createIndex('bookId','bookId');}
      for(const name of ['reading-state','book-revisions'])if(!d.objectStoreNames.contains(name))d.createObjectStore(name,{keyPath:'id'});
    };r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};
  });}
  function capture(book){
    const meta={...book};for(const key of STATE)delete meta[key];
    meta.chapters=(book.chapters||[]).map(chapter=>{const c={...chapter};delete c.text;return c;});
    const state={id:book.id};for(const key of STATE)if(book[key]!==undefined)state[key]=book[key];
    return{id:book.id,metaJSON:JSON.stringify(meta),stateJSON:JSON.stringify(state),texts:(book.chapters||[]).map(c=>String(c.text||''))};
  }
  async function migrate(legacyBooks){const db=await open();try{await new Promise((resolve,reject)=>{
    const tx=db.transaction(STORES,'readwrite'),meta=tx.objectStore('meta');let fail;
    tx.onerror=()=>reject(fail||tx.error);tx.onabort=()=>reject(fail||tx.error||error('database-aborted'));tx.oncomplete=resolve;
    const marker=meta.get('storage-layout');marker.onsuccess=()=>{if(marker.result===3)return;
      const books=tx.objectStore('books').getAll(),order=meta.get('book-order'),old=tx.objectStore('records').get('library');let remaining=3;
      const finish=()=>{if(--remaining)return;try{
        const existing=Array.isArray(books.result)?books.result:[];
        const items=existing.length||Array.isArray(order.result)?existing:Array.isArray(old.result)?old.result:legacyBooks;
        for(const book of items){if(!book?.id||!Array.isArray(book.chapters))throw error('invalid-library');const s=capture(book);
          tx.objectStore('books').put(JSON.parse(s.metaJSON));tx.objectStore('reading-state').put(JSON.parse(s.stateJSON));tx.objectStore('book-revisions').put({id:book.id,version:1,deleted:false});
          s.texts.forEach((text,index)=>{if(text)tx.objectStore('chapter-texts').put({bookId:book.id,index,text});});
        }
        const ids=new Set(items.map(b=>b.id));meta.put([...(Array.isArray(order.result)?order.result:[]).filter(id=>ids.has(id)),...items.map(b=>b.id).filter(id=>!order.result?.includes?.(id))],'book-order');
        tx.objectStore('records').delete('library');meta.put(3,'storage-layout');
      }catch(e){fail=e;tx.abort();}};books.onsuccess=order.onsuccess=old.onsuccess=finish;
    };
  });}finally{db.close();}}
  async function load({legacyBooks=[],adopt=false}={}){
    if(adopt)adopted=false;
    await migrate(legacyBooks);const db=await open();let data;
    try{data=await new Promise((resolve,reject)=>{const tx=db.transaction(STORES,'readonly');const b=tx.objectStore('books').getAll(),c=tx.objectStore('chapter-texts').getAll(),s=tx.objectStore('reading-state').getAll(),r=tx.objectStore('book-revisions').getAll(),o=tx.objectStore('meta').get('book-order');
      tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||error('database-aborted'));tx.oncomplete=()=>{
        const states=new Map(s.result.map(v=>[v.id,v])),revisions=new Map(r.result.map(v=>[v.id,v]));const books=b.result.map(book=>({...book,...states.get(book.id),chapters:book.chapters.map(ch=>({...ch,text:''}))}));const byId=new Map(books.map(v=>[v.id,v]));
        for(const row of c.result){const chapter=byId.get(row.bookId)?.chapters[row.index];if(chapter)chapter.text=row.text;}
        const positions=new Map((o.result||[]).map((id,i)=>[id,i]));books.sort((a,b)=>(positions.get(a.id)??Infinity)-(positions.get(b.id)??Infinity));resolve({books,revisions});
      };});}finally{db.close();}
    if(adopt){baseline=new Map(data.books.map(book=>[book.id,{...capture(book),version:data.revisions.get(book.id)?.version||1}]));deleted=new Set([...data.revisions.values()].filter(r=>r.deleted).map(r=>r.id));adopted=true;}
    return{books:data.books,initialized:true,migratedFromLegacy:false};
  }
  async function save(books,{stateOnly=false,bookId,deletedIds=[]}={}){
    if(!adopted)throw error('library-not-loaded');
    const snapshots=[];
    for(const book of books){if(stateOnly&&book.id!==bookId)continue;const before=baseline.get(book.id);if(stateOnly&&!before)throw error('storage-conflict');
      const next=stateOnly?{...before,stateJSON:JSON.stringify(Object.fromEntries(['id',...STATE].filter(k=>book[k]!==undefined).map(k=>[k,book[k]])))}:capture(book);
      const textChanges=[];if(!stateOnly)next.texts.forEach((text,index)=>{if(!before||text!==before.texts[index])textChanges.push({bookId:book.id,index,text});});
      const metaChanged=!stateOnly&&(!before||before.metaJSON!==next.metaJSON),stateChanged=!before||before.stateJSON!==next.stateJSON;
      if(metaChanged||stateChanged||textChanges.length)snapshots.push({...next,before,metaChanged,stateChanged,textChanges});
    }
    const deletes=[...new Set(deletedIds)];if(deletes.some(id=>!baseline.has(id)))throw error('storage-conflict');
    if(!snapshots.length&&!deletes.length)return;
    const db=await open();try{await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORES,'readwrite'),revs=tx.objectStore('book-revisions');let failure;
      tx.onerror=()=>reject(failure||tx.error);tx.onabort=()=>reject(failure||tx.error||error('database-aborted'));tx.oncomplete=resolve;
      const conflict=()=>{failure=error('storage-conflict');tx.abort();};
      for(const next of snapshots){const request=revs.get(next.id);request.onsuccess=()=>{
        const current=request.result,expected=next.before?.version;if(expected?(current?.version!==expected||current.deleted):Boolean(current))return conflict();
        if(next.metaChanged)tx.objectStore('books').put(JSON.parse(next.metaJSON));
        if(next.stateChanged)tx.objectStore('reading-state').put(JSON.parse(next.stateJSON));
        for(const row of next.textChanges){if(row.text)tx.objectStore('chapter-texts').put(row);else tx.objectStore('chapter-texts').delete([row.bookId,row.index]);}
        if(next.before&&next.texts.length<next.before.texts.length)for(let i=next.texts.length;i<next.before.texts.length;i++)tx.objectStore('chapter-texts').delete([next.id,i]);
        next.version=(expected||0)+1;revs.put({id:next.id,version:next.version,deleted:false});
      };}
      for(const id of deletes){const request=revs.get(id);request.onsuccess=()=>{const before=baseline.get(id),current=request.result;if(current?.version!==before.version||current.deleted)return conflict();
        tx.objectStore('books').delete(id);tx.objectStore('reading-state').delete(id);revs.put({id,version:current.version+1,deleted:true});
        const keys=tx.objectStore('chapter-texts').index('bookId').getAllKeys(id);keys.onsuccess=()=>keys.result.forEach(k=>tx.objectStore('chapter-texts').delete(k));
      };}
      if(!stateOnly){const order=tx.objectStore('meta').get('book-order');order.onsuccess=()=>{const own=books.map(b=>b.id).filter(id=>!deletes.includes(id));const ids=[...own,...(order.result||[]).filter(id=>!own.includes(id)&&!deletes.includes(id))];tx.objectStore('meta').put(ids,'book-order');};}
    });}finally{db.close();}
    for(const next of snapshots)baseline.set(next.id,{id:next.id,metaJSON:next.metaJSON,stateJSON:next.stateJSON,texts:next.texts,version:next.version});for(const id of deletes){baseline.delete(id);deleted.add(id);}
    channel?.postMessage({changed:true});
  }
  return{load,save,wasDeleted(id){return deleted.has(id);},onExternalChange(fn){listener=fn;},version:VERSION};
})();
