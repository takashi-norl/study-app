import { requireSuperUser } from '@/server/auth';
import { api } from '@/server/http';
import { ApiError } from '@/server/config';

/** Legacy direct generation cannot bypass the sample approval step. Existing job recovery has its own routes. */
export async function POST() {return api(async()=>{
  await requireSuperUser();
  throw new ApiError(409,'まず「問題を作る」で3問のサンプルを確認してください。既存の問題集は「アレンジ」から新しい相談を始められます。','SAMPLE_APPROVAL_REQUIRED');
});}
