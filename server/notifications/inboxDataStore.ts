import { and, count, desc, eq, isNull, lt, lte } from "drizzle-orm";
import { notificationBulkOperations as ops, notificationEvents as events,
  notificationPreferences as prefs, notificationRecipients as recipients,
  notificationSequence as sequence } from "./tables";
import type { InboxQuery, InboxView, NotificationApiStore } from "./api";
import type { InboxBulkTransaction, PersistedBulkOperation } from "./bulkOperations";
import { NOTIFICATION_KINDS } from "@shared/notificationKindCatalog";
import type { NotificationKind } from "./contract";

/**
 * SQL store is intentionally not registered with appRouter until the
 * additive migration, PAT-5 auth integration and DB rollback gate qualify.
 * The DB instance is injected, so importing this module never connects.
 */
const labels:Record<NotificationKind,{title:string;summary:string;category:InboxView["category"]}>={
  wallet_topup_approved:{title:"เติมเงินสำเร็จ",summary:"คำขอเติมเงินของคุณได้รับอนุมัติ",category:"finance"},
  wallet_topup_rejected:{title:"เติมเงินไม่ผ่าน",summary:"ตรวจสอบรายละเอียดในประวัติกระเป๋าเงิน",category:"finance"},
  order_completed:{title:"คำสั่งซื้อสำเร็จ",summary:"บันทึกคำสั่งซื้อของคุณเรียบร้อย",category:"finance"},
  episode_wallet_purchased:{title:"ซื้อตอนสำเร็จ",summary:"สิทธิ์อ่านถูกบันทึกแล้ว",category:"finance"},
  novel_published:{title:"นิยายเรื่องใหม่",summary:"มีนิยายเรื่องใหม่",category:"novel"},
  wishlist_episodes_published:{title:"Wishlist มีตอนใหม่",summary:"เรื่องที่บันทึกไว้มีตอนใหม่",category:"novel"},
  daily_checkin_reminder:{title:"อย่าลืมเช็คอิน",summary:"ตรวจสอบการเช็คอินวันนี้",category:"engagement"},
};
const kinds=new Set<string>(NOTIFICATION_KINDS);
function actor(id:number){if(!Number.isSafeInteger(id)||id<1)throw Error("Invalid notification actor");}
function affected(result:any):number{
  const header=Array.isArray(result)?result[0]:result;
  const n=header?.affectedRows;
  if(!Number.isSafeInteger(n)||n<0)throw Error("Invalid notification write outcome");
  return n;
}
export function createInboxDataStore(database:any):NotificationApiStore {
  if(!database||typeof database.transaction!=="function")throw Error("Notification DB unavailable");
  const bulk={
    transaction:<T>(fn:(tx:InboxBulkTransaction)=>Promise<T>):Promise<T>=>database.transaction(async(tx:any)=>{
      const lockOrCreateOperation=async(userId:number,key:string,kind:PersistedBulkOperation["kind"])=>{
        actor(userId);
        // Serialize FIRST, before checking whether the operation exists.
        // Otherwise two requests for one new key may both observe absence,
        // then race on the unique key after the sequence lock.
        // Recipient insertions must acquire this same sequence lock first.
        const rows=await tx.select({next:sequence.nextSequence}).from(sequence)
          .where(eq(sequence.id,1)).limit(1).for("update");
        if(rows.length!==1||rows[0].next<BigInt(1))throw Error("Notification sequence not initialized");
        const old=await tx.select().from(ops)
          .where(and(eq(ops.actorUserId,userId),eq(ops.operationKey,key))).limit(1).for("update");
        if(old.length)return old[0] as PersistedBulkOperation;
        const cutoff=BigInt(rows[0].next)-BigInt(1);
        await tx.insert(ops).values({actorUserId:userId,operationKey:key,kind,cutoffSequence:cutoff,state:"pending"});
        return {actorUserId:userId,operationKey:key,kind,cutoffSequence:cutoff,
          state:"pending" as const,affected:null};
      };
      return fn({
        lockOrCreateOperation,
        async applyToRecipients(op,now){
          const constraints=[eq(recipients.userId,op.actorUserId),
            lte(recipients.receivedSequence,op.cutoffSequence),isNull(recipients.dismissedAt)];
          const result=op.kind==="mark_all_read"
            ?await tx.update(recipients).set({readAt:now}).where(and(...constraints,isNull(recipients.readAt)))
            :await tx.update(recipients).set({dismissedAt:now}).where(and(...constraints));
          return affected(result);
        },
        async completeOperation(op,rows){
          const result=await tx.update(ops).set({state:"completed",affected:rows,completedAt:new Date()})
            .where(and(eq(ops.actorUserId,op.actorUserId),eq(ops.operationKey,op.operationKey),
              eq(ops.kind,op.kind),eq(ops.state,"pending"),eq(ops.cutoffSequence,op.cutoffSequence)));
          if(affected(result)!==1)throw Error("Bulk completion conflict");
        },
      });
    }),
  };
  return {
    async listOwnInbox(query:InboxQuery){
      actor(query.actorUserId);
      if(!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>50)throw Error("Invalid inbox page");
      const filters=[eq(recipients.userId,query.actorUserId),isNull(recipients.dismissedAt)];
      if(query.category!=="all")filters.push(eq(recipients.category,query.category));
      if(query.unreadOnly)filters.push(isNull(recipients.readAt));
      if(query.beforeSequence!==null)filters.push(lt(recipients.receivedSequence,query.beforeSequence));
      const rows=await database.select({
        id:recipients.id,category:recipients.category,kind:events.kind,
        readAt:recipients.readAt,createdAt:recipients.createdAt,
        receivedSequence:recipients.receivedSequence,
      }).from(recipients).innerJoin(events,eq(events.id,recipients.eventId))
        .where(and(...filters)).orderBy(desc(recipients.receivedSequence)).limit(query.limit);
      return rows.map((item:any)=>{
        if(!kinds.has(item.kind))throw Error("Invalid inbox kind");
        const present=labels[item.kind as NotificationKind];
        if(present.category!==item.category)throw Error("Inbox category mismatch");
        return {id:String(item.id),...present,readAt:item.readAt,
          createdAt:item.createdAt,receivedSequence:BigInt(item.receivedSequence)} as InboxView;
      });
    },
    async countOwnUnread(userId:number){
      actor(userId);
      const rows=await database.select({total:count()}).from(recipients)
        .where(and(eq(recipients.userId,userId),isNull(recipients.readAt),
          isNull(recipients.dismissedAt)));
      const n=rows[0]?.total;
      if(!Number.isSafeInteger(n)||n<0)throw Error("Invalid unread count");
      return n;
    },
    async markOwnRead(userId:number,notificationId:string){
      actor(userId);
      const id=BigInt(notificationId);
      const where=and(eq(recipients.id,id),eq(recipients.userId,userId),isNull(recipients.dismissedAt));
      const found=await database.select({readAt:recipients.readAt}).from(recipients).where(where).limit(1);
      if(found.length===0)return false;
      if(found[0].readAt!==null)return true;
      await database.update(recipients).set({readAt:new Date()})
        .where(and(where,isNull(recipients.readAt)));
      // Recheck in case a simultaneous delete-all dismissed this recipient.
      const current=await database.select({id:recipients.id}).from(recipients).where(where).limit(1);
      return current.length===1;
    },
    async getOwnPreferences(userId:number){
      actor(userId);
      const rows=await database.select({kind:prefs.kind,enabled:prefs.enabled})
        .from(prefs).where(eq(prefs.userId,userId));
      const result:Partial<Record<NotificationKind,boolean>>={};
      for(const item of rows)if(kinds.has(item.kind))result[item.kind as NotificationKind]=item.enabled;
      return result;
    },
    async setOwnPreference(userId:number,kind:NotificationKind,enabled:boolean){
      actor(userId);
      if(!kinds.has(kind)||typeof enabled!=="boolean")throw Error("Invalid preference");
      await database.transaction(async (tx:any) => {
        // Serialize with delivery insertion: both acquire the global sequence
        // row before touching preferences. A committed opt-out therefore wins
        // over a worker's earlier, non-transactional audience snapshot.
        const lock = await tx.select({next:sequence.nextSequence}).from(sequence)
          .where(eq(sequence.id,1)).limit(1).for("update");
        if(lock.length!==1||BigInt(lock[0].next)<BigInt(1))
          throw Error("Notification sequence not initialized");
        await tx.insert(prefs).values({userId,kind,enabled})
          .onDuplicateKeyUpdate({set:{enabled,updatedAt:new Date()}});
      });
    },
    bulk,
  };
}
