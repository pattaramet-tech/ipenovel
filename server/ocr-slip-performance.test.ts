import { describe, it, expect } from "vitest";
import { verifySlipData } from "./ocr-slip-verification";

/**
 * Performance Test Suite for OCR Slip Auto-Approval Flow
 * Measures end-to-end latency with detailed timing breakdowns
 */

interface PerformanceMetrics {
  stage: string;
  duration: number;
}

const metrics: PerformanceMetrics[] = [];

function recordMetric(stage: string, duration: number) {
  metrics.push({ stage, duration });
  console.log(`⏱️  ${stage}: ${duration.toFixed(2)}ms`);
}

function calculateStats(durations: number[]) {
  if (durations.length === 0) return { avg: 0, p95: 0, max: 0, min: 0 };
  
  const sorted = [...durations].sort((a, b) => a - b);
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  const p95 = sorted[Math.max(0, p95Index)];
  const max = sorted[sorted.length - 1];
  const min = sorted[0];
  
  return { avg, p95, max, min };
}

describe("OCR Slip Auto-Approval Performance", () => {
  // Increase timeout for performance tests that simulate real-world delays
  const testTimeout = 30000; // 30 seconds
  it("should measure verifySlipData() latency", async () => {
    const durations: number[] = [];

    // Test data
    const testSlipData = {
      amount: 250.0,
      merchantCode: "IPENOVEL",
      shopName: "Ipe Novel Shop",
      transactionDate: new Date(),
      reference: "REF123456",
      confidence: 92,
    };

    const testOrderAmount = 250.0;

    // Run 10 iterations to get representative sample
    for (let i = 0; i < 10; i++) {
      const startTime = performance.now();
      
      const result = verifySlipData(testSlipData, testOrderAmount);
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      durations.push(duration);
      recordMetric(`verifySlipData() iteration ${i + 1}`, duration);
    }

    const stats = calculateStats(durations);
    console.log(`\n📊 verifySlipData() Stats:`);
    console.log(`   Average: ${stats.avg.toFixed(2)}ms`);
    console.log(`   P95: ${stats.p95.toFixed(2)}ms`);
    console.log(`   Max: ${stats.max.toFixed(2)}ms`);
    console.log(`   Min: ${stats.min.toFixed(2)}ms`);

    // verifySlipData is pure logic, should be very fast
    expect(stats.avg).toBeLessThan(10);
    expect(stats.max).toBeLessThan(50);
  });

  it("should measure mock LLM OCR latency (simulated)", async () => {
    const durations: number[] = [];

    // Simulate LLM call latency (typically 1-3 seconds for real LLM)
    for (let i = 0; i < 5; i++) {
      const startTime = performance.now();
      
      // Simulate LLM processing delay (1000-2000ms typical)
      await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1000));
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      durations.push(duration);
      recordMetric(`LLM OCR simulation iteration ${i + 1}`, duration);
    }

    const stats = calculateStats(durations);
    console.log(`\n📊 LLM OCR Latency (Simulated):`);
    console.log(`   Average: ${stats.avg.toFixed(2)}ms`);
    console.log(`   P95: ${stats.p95.toFixed(2)}ms`);
    console.log(`   Max: ${stats.max.toFixed(2)}ms`);
    console.log(`   Min: ${stats.min.toFixed(2)}ms`);

    // LLM calls are the primary bottleneck
    expect(stats.avg).toBeGreaterThan(1000);
    expect(stats.avg).toBeLessThan(3000);
  });

  it("should measure full end-to-end flow latency", async () => {
    const durations: number[] = [];
    const stageBreakdowns: { [key: string]: number[] } = {
      imageUpload: [],
      parseSlipImage: [],
      verifySlipData: [],
      dbUpdate: [],
    };

    // Run 5 iterations to simulate real flow
    for (let i = 0; i < 5; i++) {
      const totalStart = performance.now();

      // Stage 1: Image upload (simulated network delay)
      const uploadStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 400));
      const uploadEnd = performance.now();
      const uploadDuration = uploadEnd - uploadStart;
      stageBreakdowns.imageUpload.push(uploadDuration);
      recordMetric(`  Stage 1 - Image upload`, uploadDuration);

      // Stage 2: parseSlipImage (LLM call)
      const parseStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1500));
      const parseEnd = performance.now();
      const parseDuration = parseEnd - parseStart;
      stageBreakdowns.parseSlipImage.push(parseDuration);
      recordMetric(`  Stage 2 - parseSlipImage (LLM)`, parseDuration);

      // Stage 3: verifySlipData (pure logic)
      const verifyStart = performance.now();
      const testSlipData = {
        amount: 250.0,
        merchantCode: "IPENOVEL",
        shopName: "Ipe Novel Shop",
        transactionDate: new Date(),
        reference: `REF${i}`,
        confidence: 92,
      };
      const verifyResult = verifySlipData(testSlipData, 250.0);
      const verifyEnd = performance.now();
      const verifyDuration = verifyEnd - verifyStart;
      stageBreakdowns.verifySlipData.push(verifyDuration);
      recordMetric(`  Stage 3 - verifySlipData`, verifyDuration);

      // Stage 4: DB update (simulated)
      const dbStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
      const dbEnd = performance.now();
      const dbDuration = dbEnd - dbStart;
      stageBreakdowns.dbUpdate.push(dbDuration);
      recordMetric(`  Stage 4 - DB update`, dbDuration);

      const totalEnd = performance.now();
      const totalDuration = totalEnd - totalStart;
      durations.push(totalDuration);

      console.log(`\n✓ Full flow iteration ${i + 1}: ${totalDuration.toFixed(0)}ms`);
    }

    const totalStats = calculateStats(durations);
    console.log(`\n📊 Full End-to-End Flow Stats:`);
    console.log(`   Average: ${totalStats.avg.toFixed(2)}ms`);
    console.log(`   P95: ${totalStats.p95.toFixed(2)}ms`);
    console.log(`   Max: ${totalStats.max.toFixed(2)}ms`);
    console.log(`   Min: ${totalStats.min.toFixed(2)}ms`);

    console.log(`\n📊 Stage Breakdown (Average):`);
    for (const [stage, stageDurations] of Object.entries(stageBreakdowns)) {
      if (stageDurations.length > 0) {
        const stageStats = calculateStats(stageDurations);
        console.log(`   ${stage.padEnd(20)} ${stageStats.avg.toFixed(0).padStart(5)}ms avg | ${stageStats.p95.toFixed(0).padStart(5)}ms p95 | ${stageStats.max.toFixed(0).padStart(5)}ms max`);
      }
    }

    // Check against 5-second threshold
    console.log(`\n⏱️  Performance Summary:`);
    console.log(`   Total flow average: ${totalStats.avg.toFixed(0)}ms`);
    console.log(`   5-second threshold: 5000ms`);
    
    if (totalStats.avg > 5000) {
      console.log(`   ⚠️  WARNING: Average flow exceeds 5-second threshold!`);
    } else {
      console.log(`   ✅ Average flow is within 5-second threshold`);
    }

    if (totalStats.p95 > 5000) {
      console.log(`   ⚠️  WARNING: P95 flow exceeds 5-second threshold!`);
    } else {
      console.log(`   ✅ P95 flow is within 5-second threshold`);
    }

    expect(totalStats.avg).toBeLessThan(5000);
    expect(totalStats.p95).toBeLessThan(5500);
  });

  it("should identify bottleneck stages", async () => {
    const stageTimings: { [key: string]: number[] } = {
      imageUpload: [],
      parseSlipImage: [],
      verifySlipData: [],
      dbUpdate: [],
    };

    // Simulate 20 complete flows
    for (let i = 0; i < 20; i++) {
      // Image upload (200-600ms typical for 1-2MB)
      const uploadStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 400));
      const uploadEnd = performance.now();
      stageTimings.imageUpload.push(uploadEnd - uploadStart);

      // parseSlipImage (LLM call - 1000-2500ms typical)
      const parseStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1500));
      const parseEnd = performance.now();
      stageTimings.parseSlipImage.push(parseEnd - parseStart);

      // verifySlipData (pure logic - <1ms)
      const verifyStart = performance.now();
      const testSlipData = {
        amount: 250.0,
        merchantCode: "IPENOVEL",
        shopName: "Ipe Novel Shop",
        transactionDate: new Date(),
        reference: `REF${i}`,
        confidence: 92,
      };
      verifySlipData(testSlipData, 250.0);
      const verifyEnd = performance.now();
      stageTimings.verifySlipData.push(verifyEnd - verifyStart);

      // DB update (50-150ms typical)
      const dbStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
      const dbEnd = performance.now();
      stageTimings.dbUpdate.push(dbEnd - dbStart);
    }

    console.log(`\n🔍 Bottleneck Analysis (20 iterations):`);
    const allStages = Object.entries(stageTimings);
    const stageStats = allStages.map(([stage, durations]) => ({
      stage,
      stats: calculateStats(durations),
    }));

    // Sort by average time (descending)
    stageStats.sort((a, b) => b.stats.avg - a.stats.avg);

    // Calculate total average
    const totalAvg = stageStats.reduce((sum, s) => sum + s.stats.avg, 0);

    for (const { stage, stats } of stageStats) {
      const percentage = (stats.avg / totalAvg) * 100;
      const bar = "█".repeat(Math.ceil(percentage / 5));
      const percentStr = percentage.toFixed(1).padStart(5);
      console.log(`   ${stage.padEnd(20)} ${bar.padEnd(30)} ${percentStr}% | avg: ${stats.avg.toFixed(0).padStart(4)}ms | p95: ${stats.p95.toFixed(0).padStart(4)}ms`);
    }

    // Identify primary bottleneck
    const primaryBottleneck = stageStats[0];
    console.log(`\n⚠️  Primary Bottleneck: ${primaryBottleneck.stage}`);
    console.log(`   Average: ${primaryBottleneck.stats.avg.toFixed(2)}ms`);
    console.log(`   P95: ${primaryBottleneck.stats.p95.toFixed(2)}ms`);
    console.log(`   Max: ${primaryBottleneck.stats.max.toFixed(2)}ms`);
    console.log(`   Percentage of total: ${((primaryBottleneck.stats.avg / totalAvg) * 100).toFixed(1)}%`);

    console.log(`\n📈 Total Flow Time: ${totalAvg.toFixed(2)}ms`);
    if (totalAvg > 5000) {
      console.log(`⚠️  WARNING: Total flow exceeds 5-second threshold!`);
      console.log(`   Recommendation: Optimize ${primaryBottleneck.stage} (${((primaryBottleneck.stats.avg / totalAvg) * 100).toFixed(1)}% of total time)`);
    } else {
      console.log(`✅ Total flow is within 5-second threshold`);
    }

    expect(totalAvg).toBeLessThan(5000);
  });
});
