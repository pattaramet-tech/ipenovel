import { describe, it, expect } from "vitest";
import { walletService } from "./wallet.service";
import { db } from "./db";

describe("Wallet Service - Core Tests", () => {
  describe("Service Methods Exist", () => {
    it("should have adminApproveWalletTopup method", () => {
      expect(walletService.adminApproveWalletTopup).toBeDefined();
      expect(typeof walletService.adminApproveWalletTopup).toBe("function");
    });

    it("should have adminRejectWalletTopup method", () => {
      expect(walletService.adminRejectWalletTopup).toBeDefined();
      expect(typeof walletService.adminRejectWalletTopup).toBe("function");
    });

    it("should have createWalletTopupRequest method", () => {
      expect(walletService.createWalletTopupRequest).toBeDefined();
      expect(typeof walletService.createWalletTopupRequest).toBe("function");
    });

    it("should have uploadWalletTopupSlip method", () => {
      expect(walletService.uploadWalletTopupSlip).toBeDefined();
      expect(typeof walletService.uploadWalletTopupSlip).toBe("function");
    });
  });

  describe("Database Helpers Exist", () => {
    it("should have getWalletBalance helper", () => {
      expect(db.getWalletBalance).toBeDefined();
      expect(typeof db.getWalletBalance).toBe("function");
    });

    it("should have getWalletSummary helper", () => {
      expect(db.getWalletSummary).toBeDefined();
      expect(typeof db.getWalletSummary).toBe("function");
    });

    it("should have getWalletTransactions helper", () => {
      expect(db.getWalletTransactions).toBeDefined();
      expect(typeof db.getWalletTransactions).toBe("function");
    });

    it("should have listPendingWalletTopups helper", () => {
      expect(db.listPendingWalletTopups).toBeDefined();
      expect(typeof db.listPendingWalletTopups).toBe("function");
    });

    it("should have createWalletTransaction helper", () => {
      expect(db.createWalletTransaction).toBeDefined();
      expect(typeof db.createWalletTransaction).toBe("function");
    });

    it("should have updateWalletBalance helper", () => {
      expect(db.updateWalletBalance).toBeDefined();
      expect(typeof db.updateWalletBalance).toBe("function");
    });
  });

  describe("Wallet System Integration", () => {
    it("wallet service is properly exported", () => {
      expect(walletService).toBeDefined();
      expect(typeof walletService).toBe("object");
    });

    it("all required methods are callable", () => {
      const methods = [
        "createWalletTopupRequest",
        "uploadWalletTopupSlip",
        "adminApproveWalletTopup",
        "adminRejectWalletTopup",
      ];
      methods.forEach(method => {
        expect(typeof walletService[method as keyof typeof walletService]).toBe("function");
      });
    });

    it("database helpers are properly exported", () => {
      expect(db).toBeDefined();
      expect(typeof db).toBe("object");
    });
  });
});
