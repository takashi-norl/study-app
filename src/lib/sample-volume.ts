export type BulkVolumeInput = { mode: 'total'; total: number | null } | { mode: 'schedule'; days: number; daily: number };
export type BulkVolume = { valid: true; total: number } | { valid: false; message: string };
export function resolveBulkVolume(input: BulkVolumeInput): BulkVolume {
  if(input.mode==='total' && input.total===null) return {valid:false,message:'新しく作る問題数を選んでください。'};
  if(input.mode==='schedule' && (!Number.isInteger(input.days)||input.days<1||!Number.isInteger(input.daily)||input.daily<1)) return {valid:false,message:'日数と1日の問題数を、1以上の整数で選んでください。'};
  const total=input.mode==='total'?input.total!:input.days*input.daily;
  if(!Number.isInteger(total)||total<1||total>300) return {valid:false,message:'1回に作れるのは300問までです。日数か問題数を減らしてください。'};
  return {valid:true,total};
}
