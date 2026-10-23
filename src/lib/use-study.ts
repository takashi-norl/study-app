'use client';

import { useEffect, useRef, useState } from 'react';
import { signIn as googleSignIn, signOut as googleSignOut } from 'next-auth/react';
import type { NewLearningPlan, StudyController, UploadStatus } from '@/components/controller';
import type { Attempt, GenerationJob, LearningPlan, PracticeMode, PracticeSession, Profile, Question, Role, SourceDocument, StudyData, Subject } from './types';
import { createDemoData } from './demo-data';
import { selectQuestions } from './learning';
import { clearLocalFiles, loadLocalFile, saveLocalFile } from './local-files';
import { prepareSourceFile } from './source-files';
import { normalizePlanTags } from './plan-organization';
import { requestLibraryDelivery, type LibraryDeliveryResult } from './library-delivery';
import { pauseLoginSessionRefresh, refreshLoginSession, resumeLoginSessionRefresh } from './auth-session';
import { checkStudyAccess, isStudyStatePayload, sameStudyIdentity, studyAccessFailure, STUDY_CONNECTION_ERROR, type StudyAuthStatus, type StudyStatePayload } from './study-auth';
import { addDemoLibraryPlan, addDemoPlanningTurn, arrangeDemoTopic, deliverDemoTopic, demoPracticeQuestions, demoSessionAllowed, demoSessionQuestions, demoStudyDataForProfile, generateDemoProposal, publishDemoLibrary, requestDemoLibraryPublication, type DemoPracticeSession } from './demo-access';

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
  const [authStatus,setAuthStatus]=useState<StudyAuthStatus>('checking');
  const [authError,setAuthError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [sync,setSync]=useState<StudyController['sync']>({checking:false,lastSyncedAt:null,error:null});
  const refreshSequence=useRef(0);
  const statusChecking=useRef<number|null>(null);
  const statusCheckSequence=useRef(0);
  const lastSessionCheck=useRef(0);
  const lastSync=useRef(0);
  const [uploadStatus,setUploadStatus]=useState<UploadStatus|null>(null);
  const [practiceStart,setPracticeStart]=useState<StudyController['practiceStart']>(null);
  const pendingPractice=useRef<StudyController['practiceStart']>(null);
  const [answerConfirmation,setAnswerConfirmation]=useState(false);
  function updatePracticeStart(next:StudyController['practiceStart']){pendingPractice.current=next;setPracticeStart(next);}
  const [session,setSession]=useState<PracticeSession|null>(null);
  const [sessionQuestions,setSessionQuestions]=useState<Question[]>([]);
  const [index,setIndex]=useState(0);
  const [feedback,setFeedback]=useState<Feedback>(null);
  const lock=useRef(false);
  const signingOut=useRef(false);
  const exposed=useRef(new Set<string>());
  const planningRequests=useRef(new Map<string,string>());
  const state=useRef(data); state.current=data;
  const identity=useRef(profile); identity.current=profile;
  const currentQuestion=session && !session.completedAt ? sessionQuestions[index] ?? null : null;

  function clearAccess(status: 'checking'|'unauthenticated'){
    state.current=EMPTY;identity.current=GUEST;setData(EMPTY);setProfile(GUEST);
    updatePracticeStart(null);setSession(null);setSessionQuestions([]);setFeedback(null);setUploadStatus(null);
    planningRequests.current.clear();exposed.current.clear();lastSync.current=0;
    setAuthStatus(status);setAuthError(null);setError(null);setNotice(null);
    setSync({checking:status==='checking',lastSyncedAt:null,error:null});
  }
  function applyState(result:StudyStatePayload){
    if(signingOut.current)return;
    if(!sameStudyIdentity(identity.current,result.profile)){
      updatePracticeStart(null);setSession(null);setSessionQuestions([]);setFeedback(null);setUploadStatus(null);
      planningRequests.current.clear();exposed.current.clear();
    }
    state.current=result.data;identity.current=result.profile;setData(result.data);setProfile(result.profile);
    setAuthStatus('authenticated');setAuthError(null);
    lastSync.current=Date.now();setSync({checking:false,lastSyncedAt:lastSync.current,error:null});
  }
  function applyAccessFailure(result:ReturnType<typeof studyAccessFailure>){
    if(signingOut.current)return;
    if(result.status==='unauthenticated'){clearAccess('unauthenticated');return;}
    if(result.identityChanged)clearAccess('checking');
    setSync(previous=>({...previous,checking:false,error:result.message}));
    // Preserve the current screen and unsaved work when already-loaded data is still usable.
    if(identity.current.id==='guest'){setAuthStatus('unavailable');setAuthError(result.message);}
  }
  async function readState(signal?:AbortSignal):Promise<StudyStatePayload>{
    const controller=new AbortController();
    const abort=()=>controller.abort();
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(abort,15000);
    try {
      const result=await api<unknown>('/api/state','GET',undefined,controller.signal);
      if(!isStudyStatePayload(result))throw new Error(STUDY_CONNECTION_ERROR);
      return result;
    }catch(error){
      if(controller.signal.aborted&&!signal?.aborted)throw new Error('最新の状況の取得に時間がかかっています。依頼は受け付け済みの場合があります。「最新の状態を確認」から確認してください。');
      throw error;
    }finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
  }
  async function refresh(signal?:AbortSignal){
    if(signingOut.current)throw new Error('ログアウトしています。');
    const sequence=++refreshSequence.current;
    setSync(previous=>({...previous,checking:true}));
    try{
      const result=await readState(signal);
      if(sequence===refreshSequence.current&&!signal?.aborted)applyState(result);
      return result;
    }catch(error){
      if(sequence===refreshSequence.current&&!signal?.aborted)applyAccessFailure(studyAccessFailure(error));
      throw error;
    }
  }
  async function checkAuthentication(signal?:AbortSignal){
    if(signingOut.current)return;
    const sequence=++refreshSequence.current;
    setSync(previous=>({...previous,checking:true}));
    if(identity.current.id==='guest'){setAuthStatus('checking');setAuthError(null);}
    const result=await checkStudyAccess(refreshLoginSession,async currentProfile=>{
      if(signal?.aborted||sequence!==refreshSequence.current)throw new Error('確認は中断されました。');
      if(!sameStudyIdentity(identity.current,currentProfile))clearAccess('checking');
      return readState(signal);
    });
    if(sequence!==refreshSequence.current||signal?.aborted)return;
    lastSessionCheck.current=Date.now();
    if(result.status==='authenticated')applyState(result);else applyAccessFailure(result);
  }
  async function retryAuth(){
    if(demo||signingOut.current||lock.current||statusChecking.current!==null)return;
    const token=++statusCheckSequence.current;statusChecking.current=token;
    try{await checkAuthentication();}finally{if(statusChecking.current===token)statusChecking.current=null;}
  }
  async function refreshStatus(){
    if(demo||signingOut.current||lock.current||statusChecking.current!==null)return;
    const token=++statusCheckSequence.current;statusChecking.current=token;
    try{await refresh();}catch{/* The connection state remains visible without claiming that the AI job stopped. */}
    finally{if(statusChecking.current===token)statusChecking.current=null;}
  }
  async function run(task:()=>Promise<void>){
    if(signingOut.current||lock.current)return;
    if(!demo&&(identity.current.id==='guest'||!sameStudyIdentity(identity.current,profile)))return;
    // A read started before this mutation must never replace its local result.
    refreshSequence.current+=1;
    setSync(previous=>({...previous,checking:false}));
    lock.current=true;setBusy(true);setError(null);setNotice(null);
    try{await task();}catch(e){
      if(signingOut.current)return;
      if(!demo&&studyAccessFailure(e).status==='unauthenticated')clearAccess('unauthenticated');
      else setError(e instanceof Error?e.message:'処理を完了できませんでした。');
    }
    finally{lock.current=false;setBusy(false);}
  }

  useEffect(()=>{
    let cancelled=false;
    const startup=new AbortController();
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
        state.current=loaded;setData(loaded);const demoProfile=loaded.profiles.find(p=>p.role==='student')||GUEST;
        identity.current=demoProfile;setProfile(demoProfile);setAuthStatus('authenticated');setAuthError(null);
      }else{
        await checkAuthentication(startup.signal);
      }
      if(!cancelled)setReady(true);
    }
    void initialize();
    if('serviceWorker' in navigator)void navigator.serviceWorker.register('/sw.js').catch(()=>{});
    return()=>{cancelled=true;startup.abort();refreshSequence.current+=1;statusChecking.current=null;};
  },[]);
  useEffect(()=>{
    if(ready&&demo){
      try{localStorage.setItem(KEY,JSON.stringify({...data,sources:data.sources.map(({previewUrl,...rest})=>rest)}));}
      catch{setError('この端末の保存容量が不足しています。記録を保存できませんでした。');}
    }
  },[data,demo,ready]);
  const activeAiWork=data.planningTurns.some(turn=>turn.status==='queued'||turn.status==='running')||data.jobs.some(job=>job.status==='queued'||job.status==='running');
  useEffect(()=>{
    if(demo||!ready)return;
    const interval=activeAiWork?5000:30000;
    const check=()=>{if(document.visibilityState==='visible'&&identity.current.id!=='guest'&&Date.now()-lastSync.current>=2000){
      if(Date.now()-lastSessionCheck.current>=3600000)void retryAuth();else void refreshStatus();
    }};
    const resume=()=>{if(document.visibilityState==='visible'&&Date.now()-lastSessionCheck.current>=2000)void retryAuth();};
    const timer=setInterval(check,interval);
    window.addEventListener('focus',resume);
    document.addEventListener('visibilitychange',resume);
    window.addEventListener('online',resume);
    return()=>{clearInterval(timer);window.removeEventListener('focus',resume);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);};
  },[demo,ready,profile.id,activeAiWork]);
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

  function startPractice(mode:PracticeMode,topicId?:string){
    if(lock.current || session && !session.completedAt)return;
    setError(null);setNotice(null);updatePracticeStart({mode,topicId});
  }
  async function beginPractice(requireConfirmation:boolean){
    const requested=pendingPractice.current;
    if(!requested)return;
    const {mode,topicId}=requested;
    await run(async()=>{
      setAnswerConfirmation(requireConfirmation);
      if(demo){
        const available=demoPracticeQuestions(state.current,profile,topicId);
        const previous=state.current.sessions.find(s=>demoSessionAllowed(s,available,profile)&&!s.completedAt&&s.questionIds.some(id=>!state.current.attempts.some(a=>a.sessionId===s.id&&a.questionId===id)));
        let next:DemoPracticeSession|undefined=previous;
        let questions:Question[]=[];
        if(previous)questions=demoSessionQuestions(previous,state.current.questions);
        else{
          questions=selectQuestions(available,profile.role==='parent'?[]:state.current.attempts,state.current.exposures,profile.id,profile.role==='parent'?'extra':mode,new Date(),10,topicId);
          if(!questions.length){updatePracticeStart(null);setNotice(mode==='weak'?'今、復習が必要な問題はありません。別の問題集にも挑戦してみましょう。':'今日の分はよくできました。新しい問題や次の復習日を待ちましょう。');return;}
          next={id:uid(),userId:profile.id,mode,questionIds:questions.map(q=>q.id),questionSnapshots:questions.map(question=>({...question,choices:[...question.choices],sourceIds:[...question.sourceIds]})),createdAt:new Date().toISOString()};
          setData(d=>({...d,sessions:[...d.sessions,next!]}));
        }
        setSession(next!);setSessionQuestions(questions);
        const first=questions.findIndex(q=>!state.current.attempts.some(a=>a.sessionId===next!.id&&a.questionId===q.id));
        setIndex(Math.max(0,first));setFeedback(null);
      }else{
        const result=await api<{session:PracticeSession;questions:Question[]}>('/api/practice','POST',{mode,topicId});
        const fresh=await refresh();
        if(pendingPractice.current!==requested || !sameStudyIdentity(identity.current,profile))return;
        setSession(result.session);setSessionQuestions(result.questions);setFeedback(null);
        const first=result.questions.findIndex(q=>!fresh.data.attempts.some(a=>a.sessionId===result.session.id&&a.questionId===q.id));
        setIndex(Math.max(0,first));
      }
      updatePracticeStart(null);
    });
  }
  async function answer(selectedIndex:number){
    if(!session||!currentQuestion||feedback)return false;
    let saved=false;
    await run(async()=>{
      if(!Number.isInteger(selectedIndex)||selectedIndex<0||selectedIndex>=currentQuestion.choices.length)return;
      if(demo){
        const available=demoPracticeQuestions(state.current,profile,profile.role==='parent'?currentQuestion.topicId:undefined);
        if(!demoSessionAllowed(session,available,profile)||!available.some(question=>question.id===currentQuestion.id))throw new Error('この練習には回答できません。問題集を選び直してください。');
        const attempt:Attempt=state.current.attempts.find(a=>a.sessionId===session.id&&a.questionId===currentQuestion.id)??{id:uid(),userId:profile.id,questionId:currentQuestion.id,questionVersion:currentQuestion.version,sessionId:session.id,selectedIndex,correct:selectedIndex===currentQuestion.correctIndex,answeredAt:new Date().toISOString()};
        setData(d=>({...d,attempts:d.attempts.some(a=>a.sessionId===session.id&&a.questionId===currentQuestion.id)?d.attempts:[...d.attempts,attempt]}));
        setFeedback({selectedIndex:attempt.selectedIndex,correct:attempt.correct,correctIndex:currentQuestion.correctIndex,explanation:currentQuestion.explanation});
      }else{
        const result=await api<{attempt:Attempt;feedback:{correctIndex:number;explanation:string}}>('/api/answer','POST',{sessionId:session.id,questionId:currentQuestion.id,selectedIndex,attemptId:uid()});
        setFeedback({selectedIndex:result.attempt.selectedIndex,correct:result.attempt.correct,...result.feedback});
        setData(d=>({...d,attempts:d.attempts.some(a=>a.id===result.attempt.id)?d.attempts:[...d.attempts,result.attempt]}));
      }
      saved=true;
    });
    return saved;
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
            const topic=state.current.topics.find(item=>item.id===topicId);
            if(topic?.testOnly&&profile.role!=='parent')throw new Error('テスト用の教材は管理者だけが追加できます。');
            source={id:uid(),topicId,ownerId:profile.id,name:file.name,mimeType:file.type,createdAt:new Date().toISOString(),...(topic?.testOnly?{testOnly:true}:{})};
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
      const planInput=input.tags===undefined?input:{...input,tags:normalizePlanTags(input.tags)};
      if(demo){
        if(input.testOnly&&profile.role!=='parent')throw new Error('テスト用の作成は管理者だけが利用できます。');
        const now=new Date().toISOString();
        const plan:LearningPlan={...planInput,sampleFirst:true,id:uid(),ownerId:profile.id,title:input.title?.trim()||input.goal.trim().slice(0,45),goal:input.goal.trim(),difficulty:input.difficulty||'相談して決めたい',dailyQuestionTarget:input.dailyQuestionTarget||10,version:1,createdAt:now,updatedAt:now};
        const next={...state.current,plans:[...state.current.plans,plan]};state.current=next;setData(next);planId=plan.id;
      }else{
        const result=await api<{plan:LearningPlan}>('/api/planning','POST',planInput);
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
      if(demo){
        const next=addDemoPlanningTurn(state.current,profile,planId,message);
        state.current=next;setData(next);sent=true;setNotice('操作確認用のサンプル提案を表示しました。AIへの送信や教材の読み取りは行っていません。');return;
      }
      const plan=state.current.plans.find(p=>p.id===planId);
      if(!plan||plan.ownerId!==profile.id)throw new Error('ご自身の相談を選んでください。');
      if(!message.trim())throw new Error('相談したいことを入力してください。');
      const requestId=planningRequest(`message:${planId}:${plan.version}:${message.trim()}`);
      try{await api(`/api/planning/${encodeURIComponent(planId)}/messages`,'POST',{requestId,expectedVersion:plan.version,message:message.trim()});sent=true;}
      finally{await refresh();}
      setNotice('相談を受け付けました。回答はここに保存され、画面を閉じても確認できます。');
    });return sent;
  }
  async function generateProposal(planId:string,turnId:string,proposalId:string,targetCount:number,schedule?:{dailyQuestionTarget:number;plannedDays:number}):Promise<string|void>{
    let topicId:string|undefined;
    await run(async()=>{
      if(demo){
        const result=generateDemoProposal(state.current,profile,planId,turnId,proposalId,targetCount,new Date().toISOString(),uid,{approveSamples:true,...schedule});
        state.current=result.data;setData(result.data);topicId=result.topic.id;
        setNotice(`操作確認用のサンプルを${result.topic.targetCount}問用意しました。AIによる作問ではありません。`);return;
      }
      const plan=state.current.plans.find(p=>p.id===planId);
      if(!plan||plan.ownerId!==profile.id)throw new Error('ご自身の相談を選んでください。');
      const requestId=planningRequest(`generate:${planId}:${plan.version}:${turnId}:${proposalId}:${targetCount}:${schedule?.dailyQuestionTarget??''}:${schedule?.plannedDays??''}`);
      try{
        const result=await api<{topic:{id:string}}>(`/api/planning/${encodeURIComponent(planId)}/generate`,'POST',{requestId,expectedVersion:plan.version,turnId,proposalId,targetCount,approveSamples:true,...schedule});
        topicId=result.topic.id;
      }finally{await refresh();}
      setNotice('問題作成を受け付けました。できた問題はプライベートに保存され、そのまま練習できます。');
    });return topicId;
  }
  async function arrangeTopic(topicId:string):Promise<string|void>{
    let planId:string|undefined;
    await run(async()=>{
      if(demo){const result=arrangeDemoTopic(state.current,profile,topicId);state.current=result.data;setData(result.data);planId=result.plan.id;}
      else{
        const key=`arrange:${profile.id}:${topicId}`;
        const requestId=planningRequest(key);
        const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),30000);
        try{
          const result=await api<{plan:LearningPlan}>('/api/planning/arrange','POST',{topicId,requestId},controller.signal);
          planId=result.plan.id;planningRequests.current.delete(key);
          const next={...state.current,plans:[...state.current.plans.filter(plan=>plan.id!==result.plan.id),result.plan]};state.current=next;setData(next);
          await refresh().catch(()=>{});
        }catch(error){if(controller.signal.aborted||error instanceof TypeError)throw new Error('アレンジ用の相談を保存できたか確認できませんでした。接続を確認して、同じボタンでもう一度確認できます。');throw error;}
        finally{clearTimeout(timeout);}
      }
      setNotice('アレンジ用の相談を用意しました。元の問題集は変わりません。希望を送ると、まず試作3問を作ります。');
    });return planId;
  }
  async function resumePlanningTurn(turnId:string):Promise<void>{
    await run(async()=>{
      if(demo)throw new Error('サンプルではAIへの送信を行いません。');
      const turn=state.current.planningTurns.find(item=>item.id===turnId);
      const plan=state.current.plans.find(item=>item.id===turn?.planId);
      if(!turn||!plan||plan.ownerId!==profile.id)throw new Error('ご自身の相談を選んでください。');
      if(turn.status!=='queued'&&turn.status!=='running'){await refresh();return;}
      let statusNotice='最新の実行状況を確認しました。';
      try{const result=await api<{notice?:string}>(`/api/planning/${encodeURIComponent(plan.id)}/messages`,'POST',{requestId:turn.id,expectedVersion:turn.version-1,message:turn.message});statusNotice=result.notice||statusNotice;}
      finally{await refresh();}
      setNotice(statusNotice);
    });
  }
  async function generate(topicId:string,targetCount:number,selectedSourceIds?:string[]){
    await run(async()=>{
      if(demo)throw new Error('サンプルではAI作問を実行しません。ライブラリで、用意された問題の練習・編集・共有を試せます。');
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
      const question=data.questions.find(q=>q.id===id);
      if(!question)throw new Error('問題が見つかりません。画面を更新してください。');
      if(demo){
        if(profile.role!=='parent')throw new Error('管理者だけが問題を編集できます。');
        if(data.topics.some(topic=>topic.id===question.topicId&&topic.libraryPublished))throw new Error('公開版は元の問題を修正して、新しい版として公開してください。');
        const status=patch.status==='archived'?'archived':question.testOnly?'published':patch.status==='approved'?'approved':'draft';
        setData(d=>({...d,questions:d.questions.map(q=>q.id===id?{...q,...patch,id:q.id,topicId:q.topicId,testOnly:q.testOnly,planId:q.planId,audienceUserId:q.audienceUserId,status,needsReview:q.testOnly?false:patch.needsReview??q.needsReview,publishedAt:status==='published'?new Date().toISOString():undefined,version:q.version+1}:q)}));
      }else{
        await api(`/api/questions/${encodeURIComponent(id)}`,'PATCH',{...patch,expectedVersion:question.version});await refresh();
      }
      setNotice('変更を保存しました。プライベートの練習に反映されます。パブリックの内容は、問題集を公開し直すと更新されます。');
    });
  }
  async function resumeGeneration(jobId:string){
    await run(async()=>{
      if(demo)throw new Error('サンプルではAI作問を実行しません。');
      await api(`/api/jobs/${encodeURIComponent(jobId)}/resume`,'POST',{});
      await refresh();
      setNotice('保存済みの依頼の開始を確認しました。');
    });
  }
  async function retryGeneration(jobId:string):Promise<void>{
    await run(async()=>{
      if(demo)throw new Error('サンプルではAI作問を実行しません。');
      const job=state.current.jobs.find(item=>item.id===jobId);
      if(!job||job.requestedBy!==profile.id)throw new Error('ご自身が依頼した問題作成を選んでください。');
      if(job.status!=='failed'){await refresh();setNotice('最新の作成状況を確認しました。');return;}
      const key=`retry:${profile.id}:${jobId}`;
      const requestId=planningRequest(key);
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),30000);
      let accepted:{job:GenerationJob;notice?:string};
      let reconciled=false;
      try{
        accepted=await api<{job:GenerationJob;notice?:string}>(`/api/jobs/${encodeURIComponent(jobId)}/retry`,'POST',{requestId},controller.signal);
      }catch(error){
        // The server may have accepted the request before the response was lost.
        // Retain its request ID and reconcile once; never submit another paid request automatically.
        const fresh=await refresh().catch(()=>undefined);
        const recovered=fresh?.data.jobs.find(item=>item.retryOfJobId===jobId);
        if(recovered){accepted={job:recovered,notice:recovered.status==='queued'||recovered.status==='running'?'続きの依頼は受け付け済みです。保存済みの問題を残して進めます。':'続きの作成結果を確認しました。'};reconciled=true;}
        else{
          if(controller.signal.aborted||error instanceof TypeError)throw new Error('続きの依頼が受け付けられたか確認できませんでした。接続を確認して、同じボタンでもう一度確認できます。保存済みの問題は残っています。');
          throw error;
        }
      }finally{clearTimeout(timeout);}
      const next={...state.current,jobs:[...state.current.jobs.filter(item=>item.id!==accepted.job.id),accepted.job]};
      state.current=next;setData(next);
      planningRequests.current.delete(key);
      setNotice(accepted.job.status==='queued'||accepted.job.status==='running'?'同じ条件で続きを依頼しました。保存済みの教材と問題を引き継ぎました。':accepted.notice||'続きの作成結果を確認しました。');
      // Keep the confirmed job visible even if this follow-up read loses its connection.
      if(!reconciled)await refresh().catch(()=>{});
    });
  }
  async function publish(questionIds:string[],at?:string){
    await run(async()=>{
      if(!questionIds.length)throw new Error('公開する問題を選んでください。');
      if(demo){
        const questions=data.questions.filter(q=>questionIds.includes(q.id));
        if(questions.some(question=>question.testOnly||data.topics.some(topic=>topic.id===question.topicId&&(topic.testOnly||topic.libraryPublished))))throw new Error('テスト用の問題は「ライブラリに公開」からコピーして公開してください。公開版は元の問題を修正してください。');
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
  async function publishLibrary(topicId:string):Promise<string|void>{
    let resultId:string|undefined;
    await run(async()=>{
      if(demo){
        const result=publishDemoLibrary(state.current,profile,topicId);
        state.current=result.data;setData(result.data);resultId=result.topic.id;
      }else{
        const result=await api<{topic:{id:string}}>('/api/library/publish','POST',{topicId});
        resultId=result.topic.id;await refresh();
      }
      setNotice('登録ユーザー向けのパブリックに公開しました。元の問題集と教材・相談履歴はプライベートに残ります。');
    });return resultId;
  }
  async function requestLibraryPublication(topicId:string):Promise<boolean>{
    let sent=false;
    await run(async()=>{
      if(demo){
        const result=requestDemoLibraryPublication(state.current,profile,topicId);
        state.current=result.data;setData(result.data);
      }else{
        await api('/api/library/request-publication','POST',{topicId});await refresh();
      }
      sent=true;setNotice('管理者に公開を依頼しました。待つ間もプライベートで練習できます。');
    });return sent;
  }
  async function addLibraryPlan(topicId:string):Promise<string|void>{
    let resultId:string|undefined;
    await run(async()=>{
      if(demo){
        const result=addDemoLibraryPlan(state.current,profile,topicId);
        state.current=result.data;setData(result.data);resultId=result.plan.id;
      }else{
        const result=await api<{plan:{id:string}}>('/api/library/add','POST',{topicId});
        resultId=result.plan.id;await refresh();
      }
      setNotice('自分の学習に追加しました。1回10問ずつ練習できます。');
    });return resultId;
  }
  async function deliverToLearner(topicId:string,learnerId:string,projectName:string):Promise<string|void>{
    let resultId:string|undefined;
    await run(async()=>{
      const learner=state.current.profiles.find(member=>member.id===learnerId&&member.role==='student'&&member.familyId===profile.familyId);
      if(profile.role!=='parent'||!learner)throw new Error('管理者から、ご家族の学習者を選んで追加してください。');
      let result:LibraryDeliveryResult;
      if(demo){
        const delivered=await requestLibraryDelivery(planningRequests.current,profile.id,{topicId,learnerId,projectName},body=>deliverDemoTopic(state.current,profile,body));
        state.current=delivered.data;setData(delivered.data);result=delivered;
      }else{
        result=await requestLibraryDelivery(planningRequests.current,profile.id,{topicId,learnerId,projectName},(body,signal)=>api<LibraryDeliveryResult>('/api/library/deliver','POST',body,signal));
        const next={...state.current,plans:[...state.current.plans.filter(plan=>plan.id!==result.plan.id),result.plan],topics:[...state.current.topics.filter(topic=>topic.id!==result.topic.id),result.topic]};
        state.current=next;setData(next);
        await refresh().catch(()=>{});
      }
      resultId=result.plan.id;
      setNotice(`${learner.name}さんの学習に${result.deliveredCount}問を追加しました。原本の写真や相談履歴は共有していません。`);
    });return resultId;
  }
  async function updatePlanTags(planId:string,tags:string[]):Promise<boolean>{
    let saved=false;
    await run(async()=>{
      const normalized=[...new Set(tags.map(tag=>tag.trim()).filter(Boolean))];
      if(normalized.length>8 || normalized.some(tag=>tag.length>40)) throw new Error('タグは8個まで、1個40文字以内で入力してください。');
      if(demo){
        const plan=state.current.plans.find(item=>item.id===planId && item.ownerId===profile.id && (!item.testOnly || profile.role==='parent'));
        if(!plan) throw new Error('自分の学習プランを選んでください。');
        const next={...state.current,plans:state.current.plans.map(item=>item.id===planId?{...item,tags:normalized}:item)};
        state.current=next;setData(next);
      }else{
        const result=await api<{plan:LearningPlan}>(`/api/plans/${encodeURIComponent(planId)}/tags`,'PATCH',{tags:normalized});
        const next={...state.current,plans:state.current.plans.map(item=>item.id===result.plan.id?{...item,tags:result.plan.tags}:item)};
        state.current=next;setData(next);
      }
      saved=true;setNotice('学習プランのタグを保存しました。');
    });return saved;
  }
  return {data:demo?demoStudyDataForProfile(data,profile):data,profile,demo,ready,authStatus,authError,busy,error,notice,uploadStatus,sync,practiceStart,answerConfirmation,session,currentQuestion,feedback,actions:{
    retryAuth,refreshStatus,updatePlanTags,startPractice,beginPractice,cancelPracticeStart(){if(!lock.current)updatePracticeStart(null);},answer,nextQuestion,createTopic,uploadSources,createPlan,sendPlanningMessage,resumePlanningTurn,generateProposal,arrangeTopic,generate,resumeGeneration,retryGeneration,updateQuestion,publish,publishLibrary,requestLibraryPublication,addLibraryPlan,deliverToLearner,requestNotifications,
    switchRole(role:Role){if(!demo)return;setProfile(data.profiles.find(p=>p.role===role)||GUEST);updatePracticeStart(null);setSession(null);setSessionQuestions([]);setFeedback(null);setError(null);setNotice(null);setUploadStatus(null);},
    finishSession(){updatePracticeStart(null);setSession(null);setSessionQuestions([]);setFeedback(null);},
    async resetDemo(){if(!demo)return;await run(async()=>{await clearLocalFiles();setData(createDemoData());updatePracticeStart(null);setSession(null);setFeedback(null);setNotice('サンプルの記録を初期状態に戻しました。');});},
    async signIn(){if(!signingOut.current)await googleSignIn('google',{callbackUrl:'/'});},
    async signOut(){
      if(demo){location.href='/';return;}
      if(signingOut.current)return;
      signingOut.current=true;refreshSequence.current+=1;statusChecking.current=null;
      clearAccess('checking');setBusy(true);
      try{
        await pauseLoginSessionRefresh();
        await googleSignOut({callbackUrl:'/'});
      }catch{
        signingOut.current=false;resumeLoginSessionRefresh();setBusy(false);
        setAuthStatus('unavailable');setAuthError('ログアウトを完了できませんでした。接続を確認して、もう一度確認してください。');
      }
    },
    exportData(){const blob=new Blob([JSON.stringify({...data,sources:data.sources.map(({previewUrl,...source})=>source)},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`hibi-study-${today(new Date().toISOString())}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
  }};
}
