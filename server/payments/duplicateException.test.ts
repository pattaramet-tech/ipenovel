import { describe, expect, it } from "vitest";
import { duplicateConfirmationKey, validateDuplicateException } from "./duplicateException";
describe("duplicate exception confirmation",()=>{
 const rows=[{subjectType:"order",subjectId:10}], ref="bank-reference";
 const input={confirmed:true,reason:"Separate settlement checked",confirmationKey:duplicateConfirmationKey(ref,rows,20)};
 it("accepts explicit current confirmation",()=>expect(()=>validateDuplicateException(input,ref,rows,20)).not.toThrow());
 it("binds confirmation to the target payment",()=>expect(()=>validateDuplicateException(input,ref,rows,21)).toThrow("RECONFIRM"));
 it("requires reconfirmation when sources change",()=>expect(()=>validateDuplicateException(input,ref,[...rows,{subjectType:"wallet",subjectId:30}],20)).toThrow("RECONFIRM"));
 it("rejects missing confirmation or blank reason",()=>{
 expect(()=>validateDuplicateException({...input,confirmed:false},ref,rows,20)).toThrow();
 expect(()=>validateDuplicateException({...input,reason:"   "},ref,rows,20)).toThrow();
 });
});
