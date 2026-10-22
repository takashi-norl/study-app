'use client';

import { useEffect, useRef, useState } from 'react';
import { signIn as googleSignIn, signOut as googleSignOut } from 'next-auth/react';
import type { NewLearningPlan, StudyController, UploadStatus } from '@/components/controller';
import type { Attempt, LearningPlan, PracticeMode, PracticeSession, Profile, Question, Role, SourceDocument, StudyData, Subject } from './types';
import { createDemoData } from './demo-data';
import { selectQuestions } from './learning';
import { clearLocalFiles, loadLocalFile, saveLocalFile } from './local-files';
import { prepareSourceFile } from './source-files';

const KEY='hibi-study-demo-v1';
const GUEST:Profile={id:'guest',familyId:'',name:'ゲスト',role:'student'};
const EMPTY:StudyData={topics:[],sources:[],questions:[],attempts:[],exposures:[],sessions:[],jobs:[],profiles:[],plans:[],planningTurns:[]};
type Feedback=StudyController['feedback'];

async function api<T>(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<T> {
  const response=await fetch(path,{method,signal,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const result=await response.json().catch(error=>{if(signal?.aborted)throw error;return {error:'応答を読み取れませんでした。'};});
  if(!response.ok) throw Object.assign(new Error(typeof result.error==='string'?result.error:'処理を完了できませんでした。'),{status:response.status});
  return result as T;
}
async function uploadRequest<T>(request:(signal:AbortSignal)=>Promise<T>,timeoutMs=120000):Promise<T> {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await request(controller.signal);}
  catch(error){
    if(controller.signal.aborted)throw new Error('通信に時間がかかっているため中断しました。電波のよい場所やWi-Fiで、下の登録済み資料を確認してから未保存の写真を選び直してください。');
    if(error instanceof TypeError)throw new Error('通信が途切れ、保存を確認できませんでした。接続を確認し、下の登録済み資料にない写真だけを選び直してください。');
    throw error;
  }finally{clearTimeout(timer);}
}
function uid(){return crypto.randomUUID();}
function today(date:string){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo'}).format(new Date(date));}

export function useStudy():StudyController {
  const [data,setData]=useState<StudyData>(EMPTY);
  const [profile,setProfile]=useState<Profile>(GUEST);
  const [demo,setDemo]=useState(false);
  const [ready,setReady]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [uploadStatus,setUploadStatus]=useState<UploadStatus|null>(null);
  const [session,setSession]=useState<PracticeSession|null>(null);
  const [sessionQuestions,setSessionQuestions]=useState<Question[]>([]);
  const [index,setIndex]=useState(0);
  const [feedback,setFeedback]=useState<Feedback>(null);
  const lock=useRef(false);
  const exposed=useRef(new Set<string>());
  const planningRequests=useRef(new Map<string,string>());
  const state=useRef(data); state.current=data;
  const currentQuestion=session && !session.completedAt ? sessionQuestions[index] ?? null : null;

  async function refresh(signal?:AbortSignal){
    const result=await api<{data:StudyData;profile:Profile}>('/api/state','GET',undefined,signal);
    state.current=result.data;setData(result.data);setProfile(result.profile);return result;
  }
  async function run(task:()=>Promise<void>){
    if(lock.current)return;
    lock.current=true;setBusy(true);setError(null);setNotice(null);
    try{await task();}catch(e){setError(e instanceof Error?e.message:'処理を完了できませんでした。');}
    finally{lock.current=false;setBusy(false);}
  }

  useEffect(()=>{
    let cancelled=false;
    async function initialize(){
      const useDemo=new URLSearchParams(location.search).get('demo')==='1';
      setDemo(useDemo);
      if(useDemo){
        let loaded=createDemoData();
        try{
          const stored=localStorage.getItem(KEY);
          if(stored){const candidate=JSON.parse(stored);if(Array.isArray(candidate?.questions)&&Array.isArray(candidate?.attempts)&&Array.isArray(candidate?.profiles))loaded=candidate;}
        }catch{}
        loaded.plans??=[];loaded.planningTurns??=[];
        loaded.sources=await Promise.all(loaded.sources.map(async source=>{
          const file=await loadLocalFile(source.id).catch(()=>undefined);
          return {...source,previewUrl:file?URL.createObjectURL(file):source.previewUrl?.startsWith('blob:')?undefined:source.previewUrl};
        }));
        if(cancelled)return;
        setData(loaded);setProfile(loaded.profiles.find(p=>p.role==='student')||GUEST);
      }else{
        try{await refresh();}
        catch(e){
          if(cancelled)return;
          if((e as {status?:number}).status===401)setNotice('ご家族のGoogleアカウントでログインしてください。');
          else setNotice('本番の接続設定を準備中です。サンプルで画面を確認できます。');
        }
      }
      if(!cancelled)setReady(true);
    }
    void initialize();
    if('serviceWorker' in navigator)void navigator.serviceWorker.register('/sw.js').catch(()=>{});
    return()=>{cancelled=true;};
  },[]);
  useEffect(()=>{
    if(ready&&demo){
      try{localStorage.setItem(KEY,JSON.stringify({...data,sources:data.sources.map(({previewUrl,...rest})=>rest)}));}
      catch{setError('この端末の保存容量が不足しています。記録を保存できませんでした。');}
    }
  },[data,demo,ready]);
  useEffect(()=>{
    if(demo||!ready||profile.id==='guest')return;
    const timer=setInterval(()=>{if(!lock.current&&document.visibilityState==='visible')void refresh().catch(()=>{});},30000);
    return()=>clearInterval(timer);
  },[demo,ready,profile.id]);
  useEffect(()=>{
    if(!currentQuestion||!session)return;
    const key=`${session.id}:${currentQuestion.id}`;
    if(exposed.current.has(key))return;
    exposed.current.add(key);
    if(demo){
      setData(previous=>previous.exposures.some(e=>e.sessionId===session.id&&e.questionId===currentQuestion.id)?previous:{...previous,exposures:[...previous.exposures,{id:uid(),userId:session.userId,sessionId:session.id,questionId:currentQuestion.id,questionVersion:currentQuestion.version,shownAt:new Date().toISOString()}]});
    }else{
      void api('/api/exposure','POST',{sessionId:session.id,questionId:currentQuestion.id}).catch(()=>{exposed.current.delete(key);});
    }
  },[currentQuestion?.id,session?.id,demo]);

  async function startPractice(mode:PracticeMode,topicId?:string){
    await run(async()=>{
      if(demo){
        const previous=state.current.sessions.find(s=>s.userId===profile.id&&!s.completedAt&&s.questionIds.some(id=>!state.current.attempts.some(a=>a.sessionId===s.id&&a.questionId===id))&&(!topicId||state.current.questions.some(q=>q.topicId===topicId&&s.questionIds.includes(q.id))));
        let next=previous;
        let questions:Question[]=[];
        if(previous)questions=previous.questionIds.map(id=>state.current.questions.find(q=>q.id===id)).filter((q):q is Question=>!!q);
        else{
          questions=selectQuestions(state.current.questions,state.current.attempts,state.current.exposures,profile.id,mode,new Date(),10,topicId);
          if(!questions.length){setNotice(mode==='weak'?'今、復習が必要な問題はありません。別の問題集にも挑戦してみましょう。':'今日の分はよくできました。新しい問題や次の復習日を待ちましょう。');return;}
          next={id:uid(),userId:profile.id,mode,questionIds:questions.map(q=>q.id),createdAt:new Date().toISOString()};
          setData(d=>({...d,sessions:[...d.sessions,next!]}));
        }
        setSession(next!);setSessionQuestions(questions);
        const first=questions.findIndex(q=>!state.current.attempts.some(a=>a.sessionId===next!.id&&a.questionId===q.id));
        setIndex(Math.max(0,first));setFeedback(null);
      }else{
        const result=await api<{session:PracticeSession;questions:Question[]}>('/api/practice','POST',{mode,topicId});
        setSession(result.session);setSessionQuestions(result.questions);setFeedback(null);
        const fresh=await refresh();
        const first=result.questions.findIndex(q=>!fresh.data.attempts.some(a=>a.sessionId===result.session.id&&a.questionId===q.id));
        setIndex(Math.max(0,first));
      }
    });
  }
  async function answer(selectedIndex:number){
    if(!session||!currentQuestion||feedback)return;
    await run(async()=>{
      if(selectedIndex<0||selectedIndex>=currentQuestion.choices.length)return;
      if(demo){
        const attempt:Attempt={id:uid(),userId:profile.id,questionId:currentQuestion.id,questionVersion:currentQuestion.version,sessionId:session.id,selectedIndex,correct:selectedIndex===currentQuestion.correctIndex,answeredAt:new Date().toISOString()};
        setData(d=>({...d,attempts:d.attempts.some(a=>a.sessionId===session.id&&a.questionId===currentQuestion.id)?d.attempts:[...d.attempts,attempt]}));
        setFeedback({correct:attempt.correct,correctIndex:currentQuestion.correctIndex,explanation:currentQuestion.explanation});
      }else{
        const result=await api<{attempt:Attempt;feedback:{correctIndex:number;explanation:string}}>('/api/answer','POST',{sessionId:session.id,questionId:currentQuestion.id,selectedIndex,attemptId:uid()});
        setFeedback({correct:result.attempt.correct,...result.feedback});
        setData(d=>({...d,attempts:d.attempts.some(a=>a.id===result.attempt.id)?d.attempts:[...d.attempts,result.attempt]}));
      }
    });
  }
  function nextQuestion(){
    if(!feedback||!session)return;
    setFeedback(null);
    if(index+1>=sessionQuestions.length){
      const completed={...session,completedAt:new Date().toISOString()};setSession(completed);
      if(demo)setData(d=>({...d,sessions:d.sessions.map(s=>s.id===session.id?completed:s)}));
      else void refresh().catch(()=>{});
    }else setIndex(index+1);
  }
  async function createTopic(title:string,subject:Subject,description:string,targetCount:number):Promise<string|void>{
    let resultId:string|undefined;
    await run(async()=>{
      if(!title.trim())throw new Error('問題集の名前を入力してください。');
      if(demo){const topic={id:uid(),title:title.trim(),subject,description,targetCount,createdAt:new Date().toISOString()};resultId=topic.id;setData(d=>({...d,topics:[...d.topics,topic]}));}
      else{const result=await api<{topic:{id:string}}>('/api/topics','POST',{title,subject,description,targetCount});resultId=result.topic.id;await refresh();}
      setNotice('問題集を作成しました。教材を追加できます。');
    });return resultId;
  }
  async function uploadSources(topicId:string|undefined,files:File[]){
    await run(async()=>{
      if(!files.length)return;
      let status:UploadStatus={topicId,fileName:files[0].name,current:1,total:files.length,completed:0,phase:'preparing',message:'写真・PDFを準備しています'};
      const requestedIds:string[]=[];
      function progress(patch:Partial<UploadStatus>){status={...status,...patch};setUploadStatus(status);}
      progress({});
      try{
        if(files.length>20)throw new Error('一度に追加できる教材は20ファイルまでです。');
        for(const [index,original] of files.entries()){
          progress({fileName:original.name,current:index+1,phase:'preparing',message:'写真・PDFを準備しています'});
          const file=await prepareSourceFile(original);
          let source:SourceDocument;
          if(demo){
            source={id:uid(),topicId,ownerId:profile.id,name:file.name,mimeType:file.type,createdAt:new Date().toISOString()};
            progress({phase:'uploading',message:'この端末に保存しています'});
            await saveLocalFile(source.id,file);source.previewUrl=URL.createObjectURL(file);
          }else{
            progress({phase:'connecting',message:'保存先に接続しています'});
            const result=await uploadRequest(signal=>api<{source:SourceDocument;signedUrl:string;path?:string}>('/api/sources/upload-token','POST',{topicId,name:file.name,mimeType:file.type,size:file.size},signal));
            requestedIds.push(result.source.id);
            progress({phase:'uploading',message:'写真・PDFをアップロードしています'});
            const response=await uploadRequest(signal=>fetch(result.signedUrl,{method:'PUT',headers:{'Content-Type':file.type},body:file,signal}));
            if(!response.ok)throw new Error(`${file.name} を保存できませんでした。下の登録済み資料を確認してから、未保存の写真を選び直してください。`);
            progress({phase:'confirming',message:'保存を確認しています'});
            const saved=await uploadRequest(signal=>api<{source:SourceDocument}>('/api/sources/complete','POST',{sourceId:result.source.id,topicId,storagePath:result.path||result.source.storagePath},signal));
            source={...saved.source,previewUrl:`/api/sources/${encodeURIComponent(saved.source.id)}`};
          }
          // Keep each confirmed file visible even if a later file fails.
          setData(d=>({...d,sources:d.sources.some(s=>s.id===source.id)?d.sources:[...d.sources,source]}));
          progress({completed:status.completed+1});
        }
        const message=demo?`${files.length}件をこの端末に保存しました。デモではAIへの送信は行いません。`:`${files.length}件を保存しました。教材を選んで、AIに作問を相談できます。`;
        progress({phase:'complete',message});setNotice(message);
      }catch(error){
        const message=error instanceof Error?error.message:'教材を保存できませんでした。接続を確認してください。';
        progress({phase:'failed',message});
        // A confirmation response can be lost after the server saves the file.
        // Reconcile once, without automatically re-uploading any photo.
        if(!demo&&requestedIds.length){
          try{
            const fresh=await uploadRequest(signal=>refresh(signal),15000);
            progress({completed:fresh.data.sources.filter(source=>requestedIds.includes(source.id)).length});
          }catch{}
        }
        throw new Error(message);
      }
    });
  }
  async function createPlan(input:NewLearningPlan):Promise<string|void>{
    let planId:string|undefined;
    await run(async()=>{
      if(!input.goal.trim())throw new Error('目標や取り組みたい内容を入力してください。');
      if(demo){
        const now=new Date().toISOString();
        const plan:LearningPlan={...input,id:uid(),ownerId:profile.id,title:input.title?.trim()||input.goal.trim().slice(0,45),goal:input.goal.trim(),difficulty:input.difficulty||'相談して決めたい',dailyQuestionTarget:input.dailyQuestionTarget||10,version:1,createdAt:now,updatedAt:now};
        setData(d=>({...d,plans:[...d.plans,plan]}));planId=plan.id;
      }else{
        const result=await api<{plan:LearningPlan}>('/api/planning','POST',input);
        planId=result.plan.id;await refresh();
      }
      setNotice('目標を保存しました。AIへの相談は、メッセージを送ると始まります。');
    });return planId;
  }
  function planningRequest(key:string){
    const existing=planningRequests.current.get(key);
    if(existing)return existing;
    const id=uid();planningRequests.current.set(key,id);return id;
  }
  async function sendPlanningMessage(planId:string,message:string):Promise<boolean>{
    let sent=false;
    await run(async()=>{
      if(demo)throw new Error('サンプルではAIへ送信しません。相談例の表示と目標の保存を試せます。');
      const plan=state.current.plans.find(p=>p.id===planId);
      if(!plan||plan.ownerId!==profile.id)throw new Error('ご自身の相談を選んでください。');
      if(!message.trim())throw new Error('相談したいことを入力してください。');
      const requestId=planningRequest(`message:${planId}:${plan.version}:${message.trim()}`);
      try{await api(`/api/planning/${encodeURIComponent(planId)}/messages`,'POST',{requestId,expectedVersion:plan.version,message:message.trim()});sent=true;}
      finally{await refresh();}
      setNotice('相談を受け付けました。回答はここに保存され、画面を閉じても確認できます。');
    });return sent;
  }
  async function generateProposal(planId:string,turnId:string,proposalId:string,targetCount:number):Promise<string|void>{
    let topicId:string|undefined;
    await run(async()=>{
      if(demo)throw new Error('サンプルではAI作問を実行しません。本番アカウントで相談・作問できます。');
      const plan=state.current.plans.find(p=>p.id===planId);
      if(!plan||plan.ownerId!==profile.id)throw new Error('ご自身の相談を選んでください。');
      const requestId=planningRequest(`generate:${planId}:${plan.version}:${turnId}:${proposalId}:${targetCount}`);
      try{
        const result=await api<{topic:{id:string}}>(`/api/planning/${encodeURIComponent(planId)}/generate`,'POST',{requestId,expectedVersion:plan.version,turnId,proposalId,targetCount});
        topicId=result.topic.id;
      }finally{await refresh();}
      setNotice(profile.role==='student'?'自習問題の作成を受け付けました。できた問題から自分の問題集に追加されます。':'問題の作成を受け付けました。できた下書きはレビューから確認できます。');
    });return topicId;
  }
  async function resumePlanningTurn(turnId:string):Promise<void>{
    await run(async()=>{
      if(demo)throw new Error('サンプルではAIへの送信を行いません。');
      const turn=state.current.planningTurns.find(item=>item.id===turnId);
      const plan=state.current.plans.find(item=>item.id===turn?.planId);
      if(!turn||!plan||plan.ownerId!==profile.id)throw new Error('ご自身の相談を選んでください。');
      if(turn.status!=='queued'&&turn.status!=='running'){await refresh();return;}
      try{await api(`/api/planning/${encodeURIComponent(plan.id)}/messages`,'POST',{requestId:turn.id,expectedVersion:turn.version-1,message:turn.message});}
      finally{await refresh();}
      setNotice('相談の開始状況を確認しました。保存済みの相談から続けます。');
    });
  }
  async function generate(topicId:string,targetCount:number,selectedSourceIds?:string[]){
    await run(async()=>{
      if(demo)throw new Error('サンプルではAI作問を実行しません。レビュー画面で、用意された下書きの編集と公開を試せます。');
      const available=data.sources;
      const sourceIds=selectedSourceIds ? [...new Set(selectedSourceIds)].filter(id=>available.some(s=>s.id===id)) : available.slice(-20).map(s=>s.id);
      if(!sourceIds.length)throw new Error('先に教材を追加してください。');
      if(sourceIds.length>20)throw new Error('一度の作問に使う資料は20件まで選んでください。');
      await api('/api/generate','POST',{topicId,sourceIds,targetCount});await refresh();
      setNotice('作問を受け付けました。この画面を閉じても処理は続きます。');
    });
  }
  async function updateQuestion(id:string,patch:Partial<Question>){
    await run(async()=>{
      if(demo){
        setData(d=>({...d,questions:d.questions.map(q=>q.id===id?{...q,...patch,id:q.id,topicId:q.topicId,status:patch.status==='approved'?'approved':'draft',publishedAt:undefined,version:q.version+1}:q)}));
      }else{
        const question=data.questions.find(q=>q.id===id);
        if(!question)throw new Error('問題が見つかりません。画面を更新してください。');
        await api(`/api/questions/${encodeURIComponent(id)}`,'PATCH',{...patch,expectedVersion:question.version});await refresh();
      }
      setNotice(patch.status==='approved'?'問題を承認しました。公開すると学習画面に追加されます。':'変更を下書きに保存しました。確認してから公開してください。');
    });
  }
  async function resumeGeneration(jobId:string){
    await run(async()=>{
      if(demo)throw new Error('サンプルではAI作問を実行しません。');
      await api(`/api/jobs/${encodeURIComponent(jobId)}/resume`,'POST',{});
      await refresh();
      setNotice('作問処理の継続を確認しました。保存済みの部分から進めます。');
    });
  }
  async function publish(questionIds:string[],at?:string){
    await run(async()=>{
      if(!questionIds.length)throw new Error('公開する問題を選んでください。');
      if(demo){
        const questions=data.questions.filter(q=>questionIds.includes(q.id));
        if(questions.some(q=>!q.prompt.trim()||q.choices.some(c=>!c.trim())||q.correctIndex<0||q.correctIndex>=q.choices.length))throw new Error('問題文・選択肢・正解を確認してください。');
        setData(d=>({...d,questions:d.questions.map(q=>questionIds.includes(q.id)?{...q,status:'published',needsReview:false,publishedAt:at||new Date().toISOString()}:q)}));
      }else{await api('/api/publish','POST',{questionIds,publishedAt:at});await refresh();}
      setNotice(at?'指定日時の公開を予約しました。':'確認した問題を公開しました。学習画面から利用できます。');
    });
  }
  async function requestNotifications(){
    await run(async()=>{
      if(demo)throw new Error('通知は本番アカウントで利用できます。');
      if(!('Notification' in window)||!('PushManager' in window))throw new Error('iPhoneではSafariからホーム画面に追加して、そのアイコンから開いてください。');
      const key=process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if(!key)throw new Error('通知の接続設定を準備中です。');
      if(await Notification.requestPermission()!=='granted')throw new Error('通知が許可されていません。許可しなくても学習できます。');
      const registration=await navigator.serviceWorker.ready;
      const base64=key.replace(/-/g,'+').replace(/_/g,'/');
      const bytes=Uint8Array.from(atob(base64+'='.repeat((4-base64.length%4)%4)),c=>c.charCodeAt(0));
      const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
      await api('/api/push/subscribe','POST',subscription.toJSON());setNotice('新しい問題の通知を有効にしました。');
    });
  }
  return {data,profile,demo,ready,busy,error,notice,uploadStatus,session,currentQuestion,feedback,actions:{
    startPractice,answer,nextQuestion,createTopic,uploadSources,createPlan,sendPlanningMessage,resumePlanningTurn,generateProposal,generate,resumeGeneration,updateQuestion,publish,requestNotifications,
    switchRole(role:Role){if(!demo)return;setProfile(data.profiles.find(p=>p.role===role)||GUEST);setSession(null);setFeedback(null);setError(null);setNotice(null);},
    finishSession(){setSession(null);setSessionQuestions([]);setFeedback(null);},
    async resetDemo(){if(!demo)return;await run(async()=>{await clearLocalFiles();setData(createDemoData());setSession(null);setFeedback(null);setNotice('サンプルの記録を初期状態に戻しました。');});},
    async signIn(){await googleSignIn('google',{callbackUrl:'/'});},
    async signOut(){if(demo){location.href='/';return;}await googleSignOut({callbackUrl:'/'});},
    exportData(){const blob=new Blob([JSON.stringify({...data,sources:data.sources.map(({previewUrl,...source})=>source)},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`hibi-study-${today(new Date().toISOString())}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
  }};
}
