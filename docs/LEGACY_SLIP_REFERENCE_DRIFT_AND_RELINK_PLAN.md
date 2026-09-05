# Legacy slip: ตรวจ DB–R2 ที่ไม่ตรงกัน และขั้นตอนผูก reference กลับ

วันที่ตรวจ: 2026-09-05 · ฐานโค้ด: `0bfea4337bcb77a7b6fe9a38476b22dbae7fc8eb`

## สรุปและขอบเขต

ไฟล์ของ 10 รายการที่ตรวจมีอยู่ใน private R2 และอ่านได้ แต่ DB ปัจจุบันยังเป็น
trusted legacy URL ข้อมูลที่มี **ยังไม่ระบุได้ว่าเหตุการณ์จริงเกิดจาก DB write
ล้มเหลว, รัน migration กับ DB อีกชุด, หรือ DB ถูก restore/เขียนทับภายหลัง**
ผู้ดูแลจำ DB ที่ใช้ตอน migration ไม่ได้ จึงไม่ใช้ข้อสันนิษฐานนี้เป็นข้อสรุป

เอกสารนี้เป็นผลวินิจฉัยและขั้นตอนสำหรับการอนุมัติงานถัดไป ไม่ใช่ apply manifest
และไม่ใช่คำสั่งอนุญาตแก้ข้อมูล ไม่มีการเชื่อมต่อ DB/R2 จริงระหว่างการตรวจโค้ดนี้
ไม่แก้แอป, schema, reference, สถานะชำระเงิน, claims, bindings หรือไฟล์ R2
ไม่ resume IPE-013 และไม่ mark backfill/dependency complete

ขอบเขตการผูกกลับในอนาคตมีเพียง:

- `order_payment` / `payments`: **11280001, 11310001, 11340002, 11340004, 11370001**
- `wallet_topup` / `walletTopups`: **180001, 210001, 240001, 270001, 300001**

ไม่รวม control payment `10020002` ที่ private อยู่แล้วและมีสอง candidate
ไม่รวม pending payment `82350007` และไม่ขยายไปทุกแถวที่ backfill เคยพบปัญหา

## 1. สิ่งที่ผล dry-run ยืนยันได้

ทั้ง 10 รายการมีสถานะดังนี้:

| ประเด็น              | ผลที่ได้รับ                                                           |
| -------------------- | --------------------------------------------------------------------- |
| DB                   | `approved`, `legacy_compatibility_required`                           |
| หลักฐานรุ่นเก่า      | `evidenceVersion=0`, evidence ID/extracted version เป็น null          |
| hash เก่าสำหรับเทียบ | ไม่มี (`SOURCE_HASH_MISSING`)                                         |
| candidate            | หนึ่งไฟล์ต่อ exact source-type/ID, ไม่มี unexpected object/truncation |
| การอ่านไฟล์          | อ่าน body ได้ครบและพบ JPEG signature; ไม่ใช่การตรวจธุรกรรมธนาคาร      |
| comparison           | `NOT_COMPARED`, ไม่ใช่ hash mismatch                                  |
| registry ที่ตรวจ     | same-source claims/bindings เป็น 0; ไม่ใช่การตรวจข้ามทุกรายการ        |
| ผลอนุมัติแผน         | 0/10; DB/R2 writes ที่รายงานเป็น 0                                    |

version 0 และไม่มี binding **ไม่ใช่หลักฐานว่า migration ล้มเหลว**: migration เดิม
ตั้งใจเปลี่ยนเฉพาะ `slipImageUrl` ไม่สร้าง immutable evidence หรือ OCR version
ส่วน audit รุ่นปัจจุบันต้องการ hash/version เดิมสำหรับวิธีพิสูจน์แบบเข้มงวด
จึงใช้เป็นทางเดียวสำหรับการซ่อม legacy กลุ่มนี้ไม่ได้ และจะไม่ลดเงื่อนไขของมัน

ไม่จำเป็นต้องมีไฟล์ก่อนย้าย R2 อีกชุดหนึ่ง: migration คัดลอก bytes เดิมโดยไม่
ย่อ/แปลงภาพ สิ่งที่ต้องตรวจเพิ่มคือ **ความสัมพันธ์ระหว่างรายการกับ object ที่มีอยู่**
ไม่ใช่ขอไฟล์ที่ย้ายไปแล้วจากผู้ใช้อีกครั้ง

## 2. เหตุที่ DB อาจยังชี้ที่เก่า: หลักฐานจากโค้ด

เส้นทางที่ตรวจคือ `migrate-legacy-manus-assets-to-r2.ts` ไม่ใช่หน้า
`/admin/media-migration` ซึ่งจัดการเฉพาะปกนิยาย/แบนเนอร์

ลำดับเดิม: **ดาวน์โหลด URL เก่า → อัปโหลด bytes เข้า R2 → UPDATE DB แบบมีเงื่อนไข**
การอัปโหลดกับ DB update ไม่ใช่ธุรกรรมเดียวกัน

| กลไก/ข้อจำกัด             | หลักฐานและผลกระทบ                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| DB update คืน false       | ระบบพยายามลบเฉพาะ object ที่เพิ่งอัปโหลด แต่หาก cleanup ล้มเหลวจะกลืน error; อาจเหลือ object โดย DB ไม่เปลี่ยน                                     |
| DB update โยน error       | ออก catch เป็น failure โดยไม่มี cleanup ในเส้นทางนี้; อาจเหลือ object โดย DB ไม่เปลี่ยน                                                            |
| โปรเซสถูกหยุดหลัง upload  | DB อาจยังไม่ถูกอัปเดต; ผลรายแถวถูกพิมพ์หลัง batch จบ จึงอาจไม่มี log รายแถวนั้น                                                                    |
| CLI มีแถว failed          | CLI พิมพ์จำนวน failed แต่ไม่กำหนด exit code ผิดพลาดสำหรับผลรายแถว; exit 0/ข้อความ Success ไม่ยืนยันว่าทุกแถวย้ายสำเร็จ                             |
| ตั้งค่า DB/R2 แยกกัน      | migration เดิมไม่ได้ pin คู่ DB–bucket; การรันกับ DB อีกชุดที่ใช้ bucket เดียวกันเป็นไปได้ แต่ยังไม่พิสูจน์ว่าเกิดขึ้นจริง                         |
| ไม่มี provenance manifest | private upload ไม่เก็บ metadata เชื่อม old URL กับ key; ชื่อโฟลเดอร์ระบุ source type/ID ที่ผู้เขียนตั้งใจ ไม่ยืนยัน DB instance หรือประวัติภายหลัง |

แหล่งอ้างอิงใน repository (เลขบรรทัดอิงฐานโค้ดด้านบน):

- `server/services/legacyManusAssetMigrationService.ts:652–700`: upload, CAS และ failure/cleanup
- `scripts/migrate-legacy-manus-assets-to-r2.ts:297–354`: รายงานผลหลัง batch และพฤติกรรม exit code
- `server/db.ts:8324–8355`: migration CAS ตรวจ ID + URL เดิม; แกะ `affectedRows` ได้ทั้ง array/header
- `server/services/r2PrivateStorage.ts:225–260`: ส่ง bytes ตรงไปยัง PutObject ไม่มี origin metadata
- `server/services/mediaMigrationService.ts:35–36`: scope ปกนิยาย/แบนเนอร์

ไม่พบหลักฐานว่า current `affectedRows` parsing ทำงานผิด จึงไม่แก้โค้ดส่วนนั้น
มี historical whitespace/CAS fix ใน `11378c677a9d2a86143b14f905e857c3434e7569`
แต่ไม่มี deployed SHA ของ migration ครั้งจริง จึงยังระบุไม่ได้ว่าเกี่ยวกับเหตุนี้
วันสร้าง control object `10020002` ไม่ใช่วันสร้าง object ของทั้ง 10 รายการ

### หลักฐานเพิ่มเติมที่ช่วยแยกสาเหตุ — read-only เท่านั้น

1. หากยังมี ให้ตรวจ log migration เฉพาะ ID เหล่านี้: `[OK]`, `[FAILED]`, failure code,
   เวลาเริ่ม/จบ, exact deployed SHA และ DB/bucket target ของการรันนั้น
   ไม่ส่ง credentials, private URLs/keys หรือ log ทั้งก้อนเข้าช่องสนทนา
2. ตรวจประวัติ import/restore ของ Preview และ DB audit/binlog **เฉพาะที่มีเก็บอยู่แล้ว**
   ไม่เปลี่ยนการตั้งค่า server หรือขอสิทธิ์ root เพียงเพื่อเดาเหตุการณ์ในอดีต
3. เวลา `createdAt`, `updatedAt`, `slipSubmittedAt`, `approvedAt` ใน DB และ R2
   `LastModified`/timestamp ใน key ช่วยจัดลำดับเหตุการณ์ แต่ไม่พิสูจน์การ restore
   หรือการอัปเดต DB สำเร็จด้วยตัวมันเอง ต้องแปลง timezone ให้ตรงกันก่อนเทียบ
4. หากต้องเทียบกับ Production/DB อีกชุด ต้องระบุ target และขอสิทธิ์ read-only
   สำหรับการเทียบเฉพาะ ID เหล่านี้ก่อน ไม่เชื่อมต่อหรือคัดลอก DB ทั้งก้อนอัตโนมัติ
5. ถ้าไม่มีข้อมูลย้อนหลัง ให้ลงผลว่า `HISTORICAL_REFERENCE_DRIFT_CAUSE_UNRESOLVED`
   แล้วใช้ขั้นตอน attestation ด้านล่าง ไม่วนขอสำเนาไฟล์ก่อน migration ที่ไม่มีแล้ว

**อย่ารัน migration เดิมแบบ live เพื่อแก้ reference ชุดนี้**: มันต้องอ่าน URL เก่า
อีกครั้ง ไม่ได้ค้นหาและ reuse candidate ที่มีอยู่ใน R2 และอาจสร้างไฟล์เพิ่ม

## 3. วิธีซ่อมที่เสนอ: reference-only ไม่ใช่ immutable migration

| ค่า                                    | ผลที่อนุญาตในงานซ่อมที่ต้องขออนุมัติแยก               |
| -------------------------------------- | ----------------------------------------------------- |
| `slipImageUrl`                         | URL legacy เดิม → `r2p:<exact reviewed existing key>` |
| `updatedAt`                            | อาจเปลี่ยนตามกลไก timestamp ของ DB; บันทึกก่อน/หลัง   |
| status/amount/approval/order/owner     | ต้องไม่เปลี่ยน                                        |
| evidenceVersion/class/ID               | คง `0` / `legacy_compatibility_required` / null       |
| extractedData/extractedEvidenceVersion | คงเดิม; ไม่เติมผล OCR/hash ย้อนหลัง                   |
| claims/bindings/unknowns/collisions    | ไม่สร้าง ไม่ลบ ไม่แก้ในขั้น reference-only            |
| เงิน/ยอด wallet/สิทธิ์ซื้อ             | ต้องไม่เปลี่ยน และไม่เรียก approve/reject/recheck     |

เหตุผล: ระบบรองรับ private references แบบ compatibility เดิมอยู่แล้ว แต่ไม่มี
writer สำหรับยกระดับ legacy เหล่านี้เป็น `legacy_migrated_immutable` ที่พร้อมใช้
การตั้ง flag/class หรือ version=1 เองจึงไม่ใช่การซ่อมที่ถูกต้อง
`legacyCaseResolutionService` เป็นเส้นทางตัดสินเคสชำระเงิน ไม่ใช่ API ซ่อม reference

## 4. ลำดับการเตรียมแผนและตรวจยืนยัน

### A. สร้าง private mapping plan จากการอ่านใหม่ — ยังไม่เขียน DB

- จำกัด exact 10 targets; ไม่เลือกไฟล์จาก newest, size หรือชื่อโฟลเดอร์เพียงอย่างเดียว
- อ่าน DB snapshot ให้ครบ: source ID/type, order/owner, status, amount, approval/
  submission timestamps, old URL แบบไม่ normalize, updatedAt, evidence/extraction
  fields และ related claims/bindings ที่เกี่ยวข้อง
- อ่าน exact R2 prefix แบบจำกัดจำนวน; ข้อมูลไม่ครบ/มีหลาย candidate/รูปแบบผิดให้หยุด
- GET ด้วย `IfMatch` จาก ETag ที่พบ, timeout/size cap, ตรวจ actual bytes และคำนวณ
  raw SHA-256 กับ canonical `SHA256(bytes + "slip:file:v1")` ใหม่
  hash ใหม่นี้เป็น fingerprint ของ object ปัจจุบัน ไม่ใช่หลักฐานว่ามี hash นี้ในอดีต
- บันทึก run ID, tool SHA, DB/bucket target fingerprint, snapshot, exact key/ETag,
  bytes/hash, proposed reference และหลักฐานยืนยันไว้ใน artifact ที่จำกัดสิทธิ์
  ใช้รายงานสาธารณะเฉพาะ ID/status/เหตุผล ไม่ส่งแผนที่มีข้อมูลสลิปเข้า chat

**ผล dry-run ที่มีเป็นรายงานแบบปกปิดข้อมูล ไม่ใช่ private mapping plan นี้**
ยังต้องอ่านใหม่เพื่อสร้างแผนจริง ไม่สามารถใช้รายการ ID อย่างเดียวเป็น apply input

### B. เลือกหลักฐานการผูกกลับหนึ่งในสองทาง

1. **Migration provenance:** มีบันทึก/DB snapshot ที่เชื่อม source และ reference
   กับ exact object ได้จริง log แค่ “migrated to private R2” ที่ไม่มี key ไม่เพียงพอ
   โดยลำพัง ต้องมีหลักฐานประกอบสำหรับ exact mapping
2. **Manual-attested mapping:** ผู้ดูแลที่มีอำนาจตรวจภาพสลิป R2 ผ่านช่องทาง private
   เทียบกับ order/top-up และบันทึกธุรกรรม/ร้านค้าที่มีอยู่ บันทึกเหตุผลและข้อขัดแย้ง
   แล้วให้ผู้ตรวจอีกคนอนุมัติ exact mapping/plan digest ที่ไม่เปลี่ยนภายหลัง
   เรียกผลนี้ว่า `ATTESTED` ไม่ใช่การพิสูจน์ bytes ย้อนหลังแบบ `VERIFIED`

จำนวนเงิน/วันที่ตรงกันหรือการติ๊กยืนยันเฉย ๆ ไม่เพียงพอ ต้องมีข้อมูลเชื่อมธุรกรรม
ที่น่าเชื่อถือประกอบ หากมีเพียง “ไฟล์เดียวใต้โฟลเดอร์ ID” หรือหลักฐานขัดกัน ให้คง
`NEEDS_MORE_EVIDENCE` ไม่อนุมัติการผูกกลับ และไม่ลบสลิป

### C. ตรวจความขัดแย้งข้ามรายการก่อนอนุมัติแผน

- เทียบ canonical hashes ของทั้ง 10 candidate กันเอง
- ตรวจ global claims, file collision registry, bindings/uploads สำหรับ hash และ
  ownership ของ object รวมถึง payment/top-up อื่นที่อ้าง `r2p:` เดียวกัน
- ผลค้นหาไม่ครบหรือเกิด conflict ให้หยุดรายการนั้นและเก็บข้อเท็จจริงไว้ ห้ามเลือก
  ผู้ชนะ ลบ registry หรือแก้ยอดชำระเงินเพื่อทำให้ผ่าน
- ย้ำว่า known-registry checks ไม่รับรองว่าไม่ซ้ำกับประวัติทั้งหมด ขณะ full legacy
  backfill ยังไม่ครบ; audit เดิมตรวจแค่ same-source จึงใช้แทนขั้นนี้ไม่ได้

## 5. ขั้นเขียนข้อมูล — ต้องมี implementation/review และอนุมัติแยกก่อน

ขั้นนี้ **ยังไม่ได้สร้างหรือรัน** ไม่มี safe apply command ในเครื่องมือ audit ปัจจุบัน

1. อนุมัติ exact plan, scope/ช่วงเวลา, ผู้ดำเนินการ และแผนกู้คืนเฉพาะแถว
   เก็บ restricted before-image และการอนุมัติไว้ ไม่ใช้ bulk DB restore เป็น rollback
2. หยุด writers ที่เกี่ยวข้องกับรายการและ object เหล่านี้ในช่วงซ่อมตามขอบเขตที่อนุมัติ
   ETag เป็น point-in-time token ไม่ใช่การรับประกันว่า object จะ immutable ตลอดไป
3. ตรวจ object bytes/version ใหม่ **ก่อน** เปิด DB transaction; ไม่ทำ network/OCR/R2
   ขณะถือ DB locks เพื่อลดปัญหาค้างแบบที่พบใน approval ก่อนหน้านี้
4. หนึ่ง short transaction ต่อรายการ ใช้ลำดับ account-mutation guard/subject locks
   ของระบบ แล้ว current locking read snapshot ใหม่ ห้ามใช้ read เก่าจาก RR snapshot
5. เปรียบเทียบ snapshot กับแผนที่อนุมัติครบทุก field/related record ที่มีผล
   ต้องยัง approved, owner/order เดิม, legacy version 0, ไม่มี binding/extraction ใหม่
6. เปลี่ยนเฉพาะ URL ด้วย guarded update ตรวจ old URL แบบ binary-exact และทุกเงื่อนไข
   ที่อนุมัติไว้ ต้อง affectedRows=1 พร้อม durable repair audit/idempotency record
   ใน transaction เดียวกัน ห้าม reuse migration CAS เก่าโดยไม่มี guard ที่เพิ่มนี้
7. commit แล้วอ่านยืนยันก่อนทำรายการถัดไป หากผล commit ไม่แน่ชัด ให้ตรวจ current
   state และ repair record ก่อน retry ห้ามส่ง update ซ้ำโดยเดา
8. พบ drift/failure ให้หยุดและรายงานว่ารายการใด committed/uncommitted/uncertain
   การคืน reference ต้องเป็น conditional restoration ที่ตรวจ state และได้รับอนุมัติ
   ห้ามลบ R2 object, claims, หลักฐาน หรือย้อนประวัติการเงินทั้งฐานข้อมูล

ตัว writer และ durable repair audit ยังต้องออกแบบ/ทดสอบใน implementation run แยก
เอกสารนี้ไม่แอบใช้ approval-resolution tables เป็น audit log สำหรับงานคนละประเภท

## 6. ตรวจหลังซ่อมและเงื่อนไขหยุด

- อ่าน DB ใหม่: reference ตรงแผน, fields ที่ห้ามเปลี่ยนคงเดิม, audit ครบ
- GET/private display ของ reference ใหม่ต้องใช้ object เดิมตาม plan hash/ETag;
  หาก object เปลี่ยน หยุดและตรวจเหตุการณ์ ไม่รายงานว่าผูกกลับสำเร็จแน่นอน
- audit แบบเข้มงวดเดิมอาจรายงาน `SKIP_ALREADY_PRIVATE` หลังซ่อม นี่เป็นผลคาดหมาย
  ไม่ใช่หลักฐานว่ายกระดับเป็น immutable หรือ historical identity ผ่านเกณฑ์เดิมแล้ว
- จากนั้นค่อยรัน **full backfill dry-run** ใหม่เพื่อวัด file-hash coverage และ collisions
  การเขียน claims/mark-complete เป็นอีกงานที่ต้องอนุมัติ ไม่รวมใน reference repair
- 10 แถวนี้ไม่รับรองว่าจะแก้ transient failures เดิมทั้ง 2,225 แถว หรือทำให้
  payment `82350007` อนุมัติได้ทันที ต้องตรวจผลใหม่ก่อนสรุป

## 7. สถานะการตรวจครั้งนี้

- ตรวจ code paths/history และผล audit ที่ผู้ใช้ส่งมา; ยังไม่มี migration execution log
  หรือ DB lineage ของครั้งจริง จึงเก็บ incident cause ไว้เป็น unresolved
- Existing migration service/CLI unit tests ผ่าน **128 tests (70 + 58)** โดยใช้ mocks
  ไม่ใช่การทดลองกับ DB/R2 จริง
- ไม่มีการแก้ source code, schema หรือ production behavior ในงานจัดทำขั้นตอนนี้
- Next action: สร้าง private mapping plan แบบ read-only ตาม A–C แล้วส่งให้ผู้ดูแล
  ตรวจยืนยัน ก่อนเริ่ม implementation ของ guarded reference-only repair

เครื่องมือ prepare-only สำหรับขั้น A–C และข้อจำกัดการใช้งานดูที่
[คู่มือเตรียม private mapping plan](PREPARE_LEGACY_SLIP_RELINK_PLAN.md)
เครื่องมือนี้ไม่ใช่ writer ในขั้น 5 และไม่ใช่การอนุมัติ mapping รายแถว
