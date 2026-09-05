# เตรียม private mapping plan สำหรับ legacy slip — ไม่มี apply

## งานนี้ทำอะไร

`scripts/prepare-legacy-slip-relink-plan.ts` เตรียมแผนตรวจยืนยันการผูก reference
กับไฟล์ private R2 ที่มีอยู่แล้ว เฉพาะ 10 รายการตาม
[แผนวินิจฉัยและผูกกลับ](LEGACY_SLIP_REFERENCE_DRIFT_AND_RELINK_PLAN.md)

**DB/R2 เป็น read-only แต่เครื่องมือสร้างไฟล์ JSON private ภายใน container**
ไม่เปลี่ยน URL, version, OCR, สถานะ approved, ยอดเงิน, claims, bindings,
unknown/collision registry หรือสิทธิ์ซื้อ ไม่ upload/delete object ไม่ mark-complete
ไม่ resume IPE-013 และไม่มี apply mode

อนุมัติให้สร้างเครื่องมือหรือรัน prepare **ไม่ใช่** การอนุมัติ mapping รายแถว
ทุกผลเริ่มด้วย `mappingProvenance: UNREVIEWED`, `approval: null`,
`writeAuthorized: false`, `isApplyManifest: false`

## ก่อนรัน

- ใช้ **Terminal ของแอป Preview บน Linux** ไม่ใช่ Terminal ของ DB
- ต้องมี source จาก commit ใหม่, Node/tsx, mysql2 และ AWS S3 SDK ใน container
- ใช้ environment ปัจจุบัน ไม่โหลด `.env` และไม่ขอให้ paste credentials
- DB/bucket ถูก pin แบบเดียวกับ audit เดิม: Preview host/database/port และ
  `ipenovel-staging-private`; ใช้เฉพาะ `R2_PRIVATE_*` ไม่มี public fallback
- ต้องเขียน `/tmp` ได้อย่างปลอดภัย: parent ไม่เป็น symlink, owner/permissions
  ผ่านการตรวจ เครื่องมือไม่รับ output path และไม่ตาม `TMPDIR` ไปที่อื่น
- Windows และ OS อื่นจะหยุดก่อนเชื่อมต่อ DB/R2; ไม่มี fallback เขียนไฟล์แบบเปิดสิทธิ์

ดู help ได้โดยไม่เชื่อมต่อหรือสร้าง artifact:

```sh
node --import tsx scripts/prepare-legacy-slip-relink-plan.ts --help
```

หลังนำ exact commit ที่ได้รับขึ้น Preview แล้ว แทน `FULL_COMMIT_SHA` ด้วย SHA
40 ตัวของ deployment นั้น:

```sh
node --import tsx scripts/prepare-legacy-slip-relink-plan.ts --prepare --confirm-preview --code-sha=FULL_COMMIT_SHA
```

หรือใช้ package script พร้อม argument ชุดเดียวกัน:

```sh
npm run prepare:legacy-slip-relink -- --prepare --confirm-preview --code-sha=FULL_COMMIT_SHA
```

`--code-sha` เป็นข้อมูลที่ operator ระบุ ไม่ได้พิสูจน์ SHA ของ deployment อัตโนมัติ
artifact ระบุ `OPERATOR_DECLARED_NOT_VERIFIED` และคำนวณ fingerprint ของ source
modules ที่อ่านจริงแยกต่างหาก ไม่อ้างว่า fingerprint นี้รับรอง dependencies/
runtime ทั้งหมดหรือประวัติ deployment

ห้ามเติม `--live`, `--apply`, `--attested`, `--limit` หรือ `--output-dir`
flag ที่ไม่รู้จัก/ซ้ำ/ขาดจะหยุดก่อน DB/R2/filesystem output

## ข้อมูลที่ตรวจ

1. จำกัด source IDs เดิมห้ารายการใน payments และห้ารายการใน walletTopups
   ไม่รวม `10020002`, `82350007` หรือช่วง ID อื่น
2. อ่าน source/order/owner และ financial/approval/evidence/OCR fields แบบระบุ
   columns ชัดเจน อ่าน related claims/bindings/unknowns/collisions แบบจำกัด
   มากกว่า 20 แถวในกลุ่มใดจะถูก block (อ่าน sentinel ไม่เกิน 21)
3. cohort ต้องยัง approved, legacy compatibility, evidence version **0**,
   evidence ID/extracted version/extracted data เป็น null และไม่มี source claim/
   binding/collision ใหม่ ข้อมูลที่เปลี่ยนจากขอบเขตนี้จะไม่ถูกยอมรับเงียบ ๆ
4. เลือก candidate ได้เฉพาะ listing ที่ครบ มีหนึ่งไฟล์ และเป็น exact prefix ของ
   source-type/ID นั้น ไม่มีการเลือก newest หรือเลือกจากขนาดตรงกัน
5. ใช้ conditional GET/ETag, timeout 10 วินาที, actual bytes ไม่เกิน 5 MiB,
   signature JPEG/PNG/PDF และคำนวณ raw/canonical hash จาก body ที่อ่านครบ
   ไม่มี retry SDK และไม่อ่าน legacy URL ที่เคยตอบ 403
6. ตรวจ canonical **และ raw** hash กับ known global claims/file collisions,
   bindings/uploads ตาม hash และ exact object identity รวมทั้ง private reference
   ที่ถูกใช้อยู่ใน payments/walletTopups; query มี timeout 5 วินาทีและจำกัดผล
   query reference TEXT อาจ scan rows ใน DB แต่ไม่ fetch ไฟล์ของรายการอื่น
7. หลังตรวจ R2 และ global references แล้ว อ่าน source snapshot ใหม่ผ่าน connection
   ใหม่ เปรียบเทียบข้อมูลทั้งชุด ไม่ถือ DB lock/transaction ระหว่าง network I/O
8. เทียบ hashes/keys ของ candidate ทั้ง 10 กันเอง ก่อนสรุปผลใด ๆ เพื่อ block
   สมาชิกทุกตัวของคู่ซ้ำ ไม่ปล่อยรายงานของตัวแรกว่าปลอดภัยก่อนอ่านตัวหลัง

เวลาใน DB snapshot เป็น string ตาม DB session **ไม่ใช่ UTC ที่แปลงแล้ว**
ส่วน `preparedAt` เป็น UTC ISO timestamp ห้ามเทียบ chronology โดยสมมติ timezone
ตรงกันเอง งบเวลา 240 วินาทีเป็นแบบตรวจระหว่างขั้นตอน; read ที่กำลังทำอาจจบช้ากว่า
แต่ละ read ยังมี timeout ของตัวเอง และรายการที่ยังไม่ตรวจจะถูกแสดงเป็น BLOCKED

## แปลผล

| สถานะ               | ความหมาย                                                                              |
| ------------------- | ------------------------------------------------------------------------------------- |
| `NEEDS_ATTESTATION` | เก็บ candidate/snapshot ได้และไม่พบ conflict ในขอบเขตที่ตรวจ ยังต้องมีคนตรวจ mapping  |
| `BLOCKED`           | ข้อมูลเปลี่ยน, candidate/bytes/ผล query ไม่ครบ, พบความขัดแย้ง หรือเงื่อนไขอื่นไม่ผ่าน |
| `SKIPPED`           | ปัจจุบันเป็น private reference อยู่แล้ว ไม่เสนอเปลี่ยนอีก                             |

Exit code: **0** = ทั้ง 10 รอตรวจยืนยัน, **1** = มี blocked/skipped,
**2** = preflight/read setup/output/fatal error
exit 0 ไม่ใช่ historical identity VERIFIED และไม่ใช่ permission ให้เขียน

`SOURCE_HASH_MISSING` เดิมไม่บังคับให้หาไฟล์ก่อน migration อีกชุด เครื่องมือนี้
ยอมให้เตรียม mapping สำหรับ version 0 ได้ แต่ hash ที่คำนวณใหม่เป็นเพียง
fingerprint ของ R2 object ปัจจุบัน ไม่ถูกเติมกลับใน OCR หรือใช้แสร้งว่ามีหลักฐานเก่า

ผลตรวจ known registries ว่างไม่รับรองว่าไม่ซ้ำกับประวัติทั้งหมด:
`historicalCoverageComplete: false` เสมอ ไม่ retire legacy scan จากผลนี้
unknown records ที่มีอยู่จะถูกเก็บใน private snapshot ไม่ลบ ไม่ supersede
และไม่เปลี่ยน classification เพียงเพราะได้ `NEEDS_ATTESTATION`

## ไฟล์ private และสิ่งที่ส่งกลับได้

- เครื่องมือสร้าง directory สุ่ม `/tmp/ipe-legacy-relink-...` สิทธิ์ **0700**
  และ `plan.json` สิทธิ์ **0600** ตรวจ ownership/inode/link count ไม่มี overwrite
- เขียน temporary file ให้ครบและ fsync ก่อนเผยแพร่ชื่อ `plan.json` ด้วย exclusive
  hard link; final ต้องมีหนึ่ง link พร้อม directory fsync
- ขนาด artifact ไม่เกิน 8 MiB; plain JSON เท่านั้น ไม่มี getters/toJSON/SDK objects
- ในไฟล์มี old URL, exact key/ETag, hash, source/order context และข้อมูลส่วนบุคคล
  **อย่า paste/แนบ `plan.json` ลง chat, issue, Git, runtime log หรือ public storage**
- stdout เป็น summary แบบ allowlist: source ID/type, สถานะ/เหตุผล, จำนวน,
  path ที่สร้างเอง และ SHA-256 ของ **ไฟล์แผน** ไม่ใช่ hash ของสลิป
  ส่งเฉพาะ summary นี้กลับมาตรวจได้
- เก็บ artifact ผ่านช่องทางที่จำกัดสิทธิ์ก่อน container ถูกสร้างใหม่;
  `/tmp` อาจไม่คงอยู่ข้าม redeploy ไม่เปิด public access ให้ bucket เพื่ออ่านสลิป
- POSIX permissions ป้องกันผู้ใช้อื่นทั่วไป ไม่ป้องกัน root/โปรเซสที่ใช้ UID เดียวกัน

หาก output ล้มเหลว เครื่องมือไม่พิมพ์ private contents เป็น fallback:

- `artifactCreated: false`: ยังไม่มีการเขียนแผนสำเร็จ/ยังไม่เริ่ม write attempt
- `artifactCreated: null`, `UNCERTAIN_CHECK_PRIVATE_DIRECTORY`: อาจมี private file
  หลัง publication error ให้ผู้ดูแลตรวจ directory ที่รายงานก่อน ห้ามถือว่ามีแผน
  ที่ finalized แล้วหรือแก้ permissions เป็น public เพื่อเปิดดู
- `artifactCreated: true`: writePlan ยืนยัน final artifact สำเร็จแล้ว

partial files/directories อาจคงเหลืออย่าง private เพื่อวินิจฉัย จะไม่ลบ final
artifact หรือเขียนทับไฟล์เดิมอัตโนมัติ การรันใหม่สร้าง directory และ plan digest ใหม่

## หลัง prepare — ต้องหยุดก่อน apply

1. ผู้ดูแลเปิด private plan ผ่านช่องทางที่มีสิทธิ์ และตรวจ exact R2 key ใน private
   console/authorized viewer เทียบกับ order/top-up และบันทึกธุรกรรมที่เกี่ยวข้อง
   ไม่ใช่ยืนยันเพียงว่าอยู่ใต้ ID หรือจำนวนเงิน/วันที่ดูตรง
2. บันทึก migration provenance ที่เชื่อม exact mapping ได้ หรือการตรวจยืนยันแบบ
   `ATTESTED` พร้อมเหตุผล/ข้อขัดแย้ง ให้ผู้ตรวจอีกคน review และผูกกับ **plan digest**
3. เก็บ review record แยกจาก plan เดิม ไม่แก้ `approval`/`writeAuthorized` ใน JSON
   เพื่อทำให้ดูเหมือนระบบอนุมัติแล้ว; เครื่องมือ prepare นี้ไม่รับ attestation หรือ apply
4. เมื่อ mapping ผ่าน จึงขออนุมัติ implementation ของ guarded reference-only
   writer แยกต่างหากตามเอกสารแผน ก่อนใช้จริงต้อง revalidate ทั้ง DB/R2 อีกครั้ง
5. ยังไม่ approve payment `82350007`, ไม่ backfill live และไม่ mark completion

สำหรับคำยืนยันของผู้ดูแลเฉพาะ `11280001` มี
[เครื่องมือบันทึกคำยืนยันและ dry-run แยก](REPAIR_LEGACY_SLIP_11280001.md)
ซึ่งยังไม่มี apply CLI ไม่อนุมัติอีก 9 รายการ และไม่แทนการทบทวน mapping คนที่สอง

## Verification ในเครื่องพัฒนา

ทดสอบแบบจำลอง read-only DB/S3, filesystem failures, strict CLI preflight และ
full-plan private JSON serialization; ไม่ใช้ credentials หรือข้อมูลจาก Preview
เครื่องพัฒนาเป็น Windows จึงมี real POSIX test ที่ skip; Docker daemon ไม่พร้อม
และไม่ได้ start service/distro เพื่อทดสอบ การตรวจ permission Linux จริงจะเกิดใน
preflight ของเครื่องมือก่อนเชื่อมต่อ DB/R2 บน Preview และจะหยุดหากไม่ปลอดภัย
