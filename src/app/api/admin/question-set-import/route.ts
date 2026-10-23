import { requireSuperUser } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { questionSetImportSchema } from '@/lib/question-set-import';
import { appendEvents, getFullState } from '@/server/google-store';
import { prepareQuestionSetImport } from '@/server/question-set-import';
import { ApiError } from '@/server/config';

export const maxDuration=180;
export async function POST(request:Request) {
  return api(async()=>{
    const {profile}=await requireSuperUser();
    const input=await readJson(request,questionSetImportSchema);
    const before=await getFullState();
    const prepared=prepareQuestionSetImport(before.data,before.events,profile,input);
    if(prepared.events.length) await appendEvents(prepared.events);
    const after=await getFullState();
    if(!prepareQuestionSetImport(after.data,after.events,profile,input).alreadyImported) throw new ApiError(503,'保存を確認できませんでした。同じファイルで再試行してください。','IMPORT_INCOMPLETE');
    return {topicId:prepared.topic.id,title:prepared.topic.title,count:prepared.questions.length,alreadyImported:prepared.alreadyImported};
  },201);
}
