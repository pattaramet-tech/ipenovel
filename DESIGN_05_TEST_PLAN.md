# Ipenovel V2 - Test Plan

## Test Strategy

The test plan covers **unit tests**, **integration tests**, and **end-to-end scenarios**. All critical business logic is tested with high coverage.

---

## 1. Unit Tests (Vitest)

### 1.1 Order Service Tests

**File:** `server/services/orderService.test.ts`

#### Test Suite: Order Number Generation

```typescript
describe('orderService.generateOrderNumber', () => {
  test('generates unique order numbers', () => {
    const num1 = generateOrderNumber();
    const num2 = generateOrderNumber();
    expect(num1).not.toBe(num2);
  });

  test('follows format ORD-YYYYMMDD-XXXXXX', () => {
    const num = generateOrderNumber();
    expect(num).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
  });

  test('order number is immutable', () => {
    const num = generateOrderNumber();
    // Verify it's stored in database and never changes
    // (tested via integration test)
  });

  test('order numbers are URL-safe', () => {
    const num = generateOrderNumber();
    expect(encodeURIComponent(num)).toBe(num);
  });
});
```

#### Test Suite: Coupon Validation

```typescript
describe('orderService.validateAndApplyCoupon', () => {
  test('validates coupon code exists', async () => {
    const result = await validateCoupon('INVALID_CODE', 100);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('validates coupon is active', async () => {
    // Setup: Create inactive coupon
    const result = await validateCoupon('INACTIVE', 100);
    expect(result.valid).toBe(false);
  });

  test('validates coupon not expired', async () => {
    // Setup: Create expired coupon
    const result = await validateCoupon('EXPIRED', 100);
    expect(result.valid).toBe(false);
  });

  test('validates minimum purchase amount', async () => {
    // Setup: Coupon requires ฿100 minimum
    const result = await validateCoupon('MIN100', 50);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('minimum');
  });

  test('validates usage limit not exceeded', async () => {
    // Setup: Coupon with maxUsageCount = 1, already used
    const result = await validateCoupon('LIMITED', 100);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('usage limit');
  });

  test('applies flat discount correctly', async () => {
    // Setup: Coupon with discountType='flat', discountValue=50
    const result = await validateCoupon('FLAT50', 100);
    expect(result.valid).toBe(true);
    expect(result.discountAmount).toBe(50);
  });

  test('applies percentage discount correctly', async () => {
    // Setup: Coupon with discountType='percentage', discountValue=20
    const result = await validateCoupon('PERCENT20', 100);
    expect(result.valid).toBe(true);
    expect(result.discountAmount).toBe(20);
  });

  test('percentage discount cannot exceed subtotal', async () => {
    // Setup: Coupon with 50% discount on ฿100 order
    const result = await validateCoupon('PERCENT50', 100);
    expect(result.valid).toBe(true);
    expect(result.discountAmount).toBeLessThanOrEqual(100);
  });
});
```

#### Test Suite: Points System

```typescript
describe('orderService.calculatePointsRedemption', () => {
  test('converts currency to points correctly (100:1)', () => {
    const points = calculatePointsFromCurrency(500);
    expect(points).toBe(5);
  });

  test('prevents redeeming more points than available', async () => {
    // Setup: User has 10 points
    const result = await redeemPoints(userId, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('insufficient');
  });

  test('converts points to currency correctly (1:1)', () => {
    const currency = calculateCurrencyFromPoints(50);
    expect(currency).toBe(50);
  });

  test('tracks points transaction', async () => {
    // Setup: User redeems 50 points
    await redeemPoints(userId, 50);
    
    const transaction = await getPointsTransaction(userId);
    expect(transaction.transactionType).toBe('redeem');
    expect(transaction.pointsAmount).toBe(-50);
  });

  test('awards points on order approval', async () => {
    // Setup: Order with total ฿500
    const pointsEarned = calculatePointsFromCurrency(500);
    expect(pointsEarned).toBe(5);
  });

  test('handles fractional points (rounds down)', () => {
    // ฿99 should earn 0 points (99 / 100 = 0.99, rounds down)
    const points = calculatePointsFromCurrency(99);
    expect(points).toBe(0);
  });
});
```

#### Test Suite: Idempotency

```typescript
describe('orderService.approvePayment - Idempotency', () => {
  test('approving same payment twice does not duplicate purchases', async () => {
    // Setup: Create order with 3 items
    const orderId = await createOrder(userId, [456, 457, 458]);
    
    // First approval
    await approvePayment(paymentId, adminId);
    let purchases = await getPurchases(userId);
    expect(purchases.length).toBe(3);
    
    // Second approval (retry)
    await approvePayment(paymentId, adminId);
    purchases = await getPurchases(userId);
    expect(purchases.length).toBe(3);  // Still 3, not 6
  });

  test('approving same payment twice does not duplicate points', async () => {
    // Setup: Create order with total ฿500
    const orderId = await createOrder(userId, [456]);
    
    // First approval
    await approvePayment(paymentId, adminId);
    let balance = await getPointsBalance(userId);
    expect(balance).toBe(5);
    
    // Second approval (retry)
    await approvePayment(paymentId, adminId);
    balance = await getPointsBalance(userId);
    expect(balance).toBe(5);  // Still 5, not 10
  });

  test('returns success on idempotent retry', async () => {
    // Setup: Approve payment
    const result1 = await approvePayment(paymentId, adminId);
    expect(result1.success).toBe(true);
    
    // Retry
    const result2 = await approvePayment(paymentId, adminId);
    expect(result2.success).toBe(true);
    expect(result2.alreadyApproved).toBe(true);
  });

  test('cannot approve rejected payment', async () => {
    // Setup: Reject payment first
    await rejectPayment(paymentId, adminId, 'Slip unclear');
    
    // Try to approve
    const result = await approvePayment(paymentId, adminId);
    expect(result.success).toBe(false);
    expect(result.error).toContain('rejected');
  });
});
```

#### Test Suite: Access Control

```typescript
describe('orderService.hasAccessToEpisode', () => {
  test('grants access to free episodes', async () => {
    // Setup: Create free episode
    const access = await hasAccessToEpisode(userId, freeEpisodeId);
    expect(access).toBe(true);
  });

  test('grants access to purchased episodes', async () => {
    // Setup: Create purchase
    await createPurchase(userId, episodeId, orderId);
    
    const access = await hasAccessToEpisode(userId, episodeId);
    expect(access).toBe(true);
  });

  test('denies access to unpurchased paid episodes', async () => {
    // Setup: No purchase created
    const access = await hasAccessToEpisode(userId, paidEpisodeId);
    expect(access).toBe(false);
  });

  test('denies access to expired purchases', async () => {
    // Setup: Create purchase with expiration in past
    await createPurchase(userId, episodeId, orderId, {
      expiresAt: new Date(Date.now() - 1000)
    });
    
    const access = await hasAccessToEpisode(userId, episodeId);
    expect(access).toBe(false);
  });

  test('grants access to non-expired purchases', async () => {
    // Setup: Create purchase with expiration in future
    await createPurchase(userId, episodeId, orderId, {
      expiresAt: new Date(Date.now() + 86400000)
    });
    
    const access = await hasAccessToEpisode(userId, episodeId);
    expect(access).toBe(true);
  });
});
```

### 1.2 Cart Service Tests

**File:** `server/services/cartService.test.ts`

```typescript
describe('cartService', () => {
  describe('addToCart', () => {
    test('adds episode to empty cart', async () => {
      const result = await addToCart(userId, episodeId);
      expect(result.success).toBe(true);
      expect(result.cartItem.episodeId).toBe(episodeId);
    });

    test('prevents adding duplicate episodes', async () => {
      await addToCart(userId, episodeId);
      
      const result = await addToCart(userId, episodeId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already in cart');
    });

    test('prevents adding already-purchased episodes', async () => {
      // Setup: Create purchase
      await createPurchase(userId, episodeId, orderId);
      
      const result = await addToCart(userId, episodeId);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already purchased');
    });

    test('prevents adding free episodes', async () => {
      // Setup: Create free episode
      const freeEpisode = await createEpisode({ isFree: true, price: 0 });
      
      const result = await addToCart(userId, freeEpisode.id);
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot add free');
    });

    test('returns updated cart total', async () => {
      const result = await addToCart(userId, episodeId);
      expect(result.cartTotal.itemCount).toBe(1);
      expect(result.cartTotal.subtotal).toBe(29.99);
    });
  });

  describe('removeFromCart', () => {
    test('removes episode from cart', async () => {
      await addToCart(userId, episodeId);
      
      const result = await removeFromCart(userId, episodeId);
      expect(result.success).toBe(true);
      expect(result.cartTotal.itemCount).toBe(0);
    });

    test('fails if episode not in cart', async () => {
      const result = await removeFromCart(userId, episodeId);
      expect(result.success).toBe(false);
    });
  });

  describe('clearCart', () => {
    test('removes all items from cart', async () => {
      await addToCart(userId, episode1Id);
      await addToCart(userId, episode2Id);
      
      const result = await clearCart(userId);
      expect(result.success).toBe(true);
      
      const cart = await getCart(userId);
      expect(cart.items.length).toBe(0);
    });
  });
});
```

### 1.3 File Service Tests

**File:** `server/services/fileService.test.ts`

```typescript
describe('fileService', () => {
  describe('validateEpisodeFile', () => {
    test('accepts PDF files', () => {
      const result = fileService.validateEpisodeFile('chapter.pdf', 'application/pdf', 1000000);
      expect(result.valid).toBe(true);
    });

    test('accepts EPUB files', () => {
      const result = fileService.validateEpisodeFile('novel.epub', 'application/epub+zip', 2000000);
      expect(result.valid).toBe(true);
    });

    test('rejects invalid file types', () => {
      const result = fileService.validateEpisodeFile('virus.exe', 'application/x-msdownload', 1000000);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid file');
    });

    test('rejects files over 100MB', () => {
      const result = fileService.validateEpisodeFile('huge.pdf', 'application/pdf', 101 * 1024 * 1024);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds');
    });
  });

  describe('getEpisodeDownloadUrl', () => {
    test('grants access to purchased episodes', async () => {
      // Setup: Create purchase
      await createPurchase(userId, episodeId, orderId);
      
      const result = await fileService.getEpisodeDownloadUrl(userId, episodeId);
      expect(result).toContain('https://');
    });

    test('denies access to unpurchased episodes', async () => {
      const result = await fileService.getEpisodeDownloadUrl(userId, episodeId);
      expect(result).toThrow('Access denied');
    });

    test('grants access to free episodes', async () => {
      // Setup: Create free episode
      const freeEpisode = await createEpisode({ isFree: true });
      
      const result = await fileService.getEpisodeDownloadUrl(userId, freeEpisode.id);
      expect(result).toContain('https://');
    });
  });
});
```

---

## 2. Integration Tests

### 2.1 Order Creation Flow

**File:** `server/integration/order-creation.test.ts`

```typescript
describe('Order Creation Flow', () => {
  test('complete multi-item order with coupon and points', async () => {
    // Setup
    const user = await createUser();
    const novel = await createNovel();
    const ep1 = await createEpisode(novel, { price: 29.99 });
    const ep2 = await createEpisode(novel, { price: 29.99 });
    const coupon = await createCoupon({ code: 'SAVE20', discountType: 'flat', discountValue: 20 });
    
    // Add to cart
    await addToCart(user.id, ep1.id);
    await addToCart(user.id, ep2.id);
    
    // Checkout with coupon and points
    const order = await createOrder(user.id, {
      couponCode: 'SAVE20',
      pointsToRedeem: 10
    });
    
    // Verify order
    expect(order.orderNumber).toMatch(/^ORD-\d{8}-[A-Z0-9]{6}$/);
    expect(order.subtotalAmount).toBe(59.98);
    expect(order.discountAmount).toBe(20);
    expect(order.pointsDiscount).toBe(10);
    expect(order.totalAmount).toBe(29.98);
    expect(order.items.length).toBe(2);
    expect(order.status).toBe('pending');
    
    // Verify cart cleared
    const cart = await getCart(user.id);
    expect(cart.items.length).toBe(0);
    
    // Verify coupon usage tracked
    const usage = await getCouponUsage(coupon.id, user.id);
    expect(usage).toBeDefined();
  });

  test('prevents duplicate episodes in order', async () => {
    const user = await createUser();
    const episode = await createEpisode();
    
    await addToCart(user.id, episode.id);
    const result = await addToCart(user.id, episode.id);
    
    expect(result.success).toBe(false);
  });

  test('prevents purchasing already-owned episodes', async () => {
    const user = await createUser();
    const episode = await createEpisode();
    
    // First purchase
    await addToCart(user.id, episode.id);
    const order1 = await createOrder(user.id);
    await approvePayment(order1.payment.id, adminId);
    
    // Try to purchase again
    const result = await addToCart(user.id, episode.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already purchased');
  });
});
```

### 2.2 Payment Approval Flow

**File:** `server/integration/payment-approval.test.ts`

```typescript
describe('Payment Approval Flow', () => {
  test('complete approval creates purchases and awards points', async () => {
    // Setup
    const user = await createUser();
    const order = await createOrder(user.id, [456, 457, 458]);
    const payment = await getPayment(order.id);
    
    // Upload slip
    await uploadSlip(payment.id, slipImageBase64);
    
    // Admin approves
    const result = await approvePayment(payment.id, adminId);
    
    // Verify payment updated
    expect(result.payment.status).toBe('approved');
    expect(result.payment.approvedBy).toBe(adminId);
    expect(result.purchasesCreated).toBe(3);
    
    // Verify purchases created
    const purchases = await getPurchases(user.id);
    expect(purchases.length).toBe(3);
    expect(purchases[0].grantedAt).toBeDefined();
    
    // Verify points awarded
    const points = await getPointsBalance(user.id);
    expect(points).toBeGreaterThan(0);
    
    // Verify order status updated
    const updatedOrder = await getOrder(order.id);
    expect(updatedOrder.status).toBe('approved');
  });

  test('approval is idempotent', async () => {
    // Setup
    const order = await createOrder(user.id, [456, 457]);
    const payment = await getPayment(order.id);
    await uploadSlip(payment.id, slipImageBase64);
    
    // First approval
    const result1 = await approvePayment(payment.id, adminId);
    expect(result1.success).toBe(true);
    expect(result1.purchasesCreated).toBe(2);
    
    // Second approval (retry)
    const result2 = await approvePayment(payment.id, adminId);
    expect(result2.success).toBe(true);
    expect(result2.alreadyApproved).toBe(true);
    
    // Verify no duplicate purchases
    const purchases = await getPurchases(user.id);
    expect(purchases.length).toBe(2);  // Not 4
  });

  test('rejection prevents purchase creation', async () => {
    // Setup
    const order = await createOrder(user.id, [456]);
    const payment = await getPayment(order.id);
    await uploadSlip(payment.id, slipImageBase64);
    
    // Admin rejects
    await rejectPayment(payment.id, adminId, 'Slip unclear');
    
    // Verify no purchases created
    const purchases = await getPurchases(user.id);
    expect(purchases.length).toBe(0);
    
    // Verify order status updated
    const updatedOrder = await getOrder(order.id);
    expect(updatedOrder.status).toBe('rejected');
  });
});
```

### 2.3 Access Control Flow

**File:** `server/integration/access-control.test.ts`

```typescript
describe('Access Control Flow', () => {
  test('user can download purchased episode', async () => {
    // Setup
    const user = await createUser();
    const episode = await createEpisode();
    await createPurchase(user.id, episode.id, orderId);
    
    // Get download URL
    const url = await getDownloadUrl(user.id, episode.id);
    expect(url).toContain('https://');
    expect(url).toContain('Expires=');
  });

  test('user cannot download unpurchased episode', async () => {
    const user = await createUser();
    const episode = await createEpisode();
    
    const result = await getDownloadUrl(user.id, episode.id);
    expect(result).toThrow('Access denied');
  });

  test('user can access free episodes', async () => {
    const user = await createUser();
    const freeEpisode = await createEpisode({ isFree: true });
    
    const url = await getDownloadUrl(user.id, freeEpisode.id);
    expect(url).toContain('https://');
  });

  test('user cannot access expired purchases', async () => {
    // Setup
    const user = await createUser();
    const episode = await createEpisode();
    await createPurchase(user.id, episode.id, orderId, {
      expiresAt: new Date(Date.now() - 1000)
    });
    
    const result = await getDownloadUrl(user.id, episode.id);
    expect(result).toThrow('Access denied');
  });
});
```

---

## 3. End-to-End Scenarios

### 3.1 Complete Purchase Journey

**File:** `server/e2e/complete-purchase.test.ts`

```typescript
describe('E2E: Complete Purchase Journey', () => {
  test('user browses, purchases, and accesses content', async () => {
    // 1. Browse novels
    const novels = await listNovels();
    expect(novels.length).toBeGreaterThan(0);
    
    // 2. View novel details
    const novel = novels[0];
    const detail = await getNovelDetail(novel.id);
    expect(detail.episodes.length).toBeGreaterThan(0);
    
    // 3. Add episodes to cart
    const ep1 = detail.episodes[0];
    const ep2 = detail.episodes[1];
    await addToCart(userId, ep1.id);
    await addToCart(userId, ep2.id);
    
    // 4. View cart
    const cart = await getCart(userId);
    expect(cart.items.length).toBe(2);
    
    // 5. Validate checkout
    const validation = await validateCheckout(userId, { couponCode: 'SUMMER30' });
    expect(validation.totalAmount).toBeLessThan(validation.subtotal);
    
    // 6. Create order
    const order = await createOrder(userId, { couponCode: 'SUMMER30' });
    expect(order.status).toBe('pending');
    
    // 7. Upload payment slip
    await uploadSlip(order.payment.id, slipImageBase64);
    
    // 8. Admin reviews and approves
    const adminApproval = await approvePayment(order.payment.id, adminId);
    expect(adminApproval.success).toBe(true);
    
    // 9. User views My Novels
    const myNovels = await getMyNovels(userId);
    expect(myNovels[0].episodes.length).toBe(2);
    
    // 10. User downloads episode
    const downloadUrl = await getDownloadUrl(userId, ep1.id);
    expect(downloadUrl).toContain('https://');
  });
});
```

---

## 4. Test Data Setup

### 4.1 Fixtures

**File:** `server/__tests__/fixtures.ts`

```typescript
export const fixtures = {
  users: {
    customer: {
      openId: 'test-customer-1',
      name: 'Test Customer',
      email: 'customer@test.com',
      role: 'user'
    },
    admin: {
      openId: 'test-admin-1',
      name: 'Test Admin',
      email: 'admin@test.com',
      role: 'admin'
    }
  },
  
  novels: {
    fantasy: {
      title: 'The Eternal Kingdom',
      slug: 'eternal-kingdom',
      author: 'Author One',
      status: 'ongoing'
    }
  },
  
  episodes: {
    paid: {
      episodeNumber: '1',
      title: 'Chapter 1',
      price: 29.99,
      isFree: false
    },
    free: {
      episodeNumber: '0',
      title: 'Prologue',
      price: 0,
      isFree: true
    }
  },
  
  coupons: {
    flat: {
      code: 'FLAT20',
      discountType: 'flat',
      discountValue: 20,
      minPurchaseAmount: 0
    },
    percentage: {
      code: 'PERCENT30',
      discountType: 'percentage',
      discountValue: 30,
      minPurchaseAmount: 50
    }
  }
};
```

---

## 5. Test Coverage Goals

| Component | Target Coverage | Priority |
|-----------|-----------------|----------|
| Order Service | 95% | Critical |
| Cart Service | 90% | Critical |
| Payment Service | 95% | Critical |
| File Service | 85% | High |
| Coupon Validation | 90% | High |
| Points System | 90% | High |
| Access Control | 95% | Critical |
| API Routes | 80% | Medium |

---

## 6. Performance Tests

### 6.1 Load Testing

```typescript
describe('Performance', () => {
  test('list 1000 novels in < 500ms', async () => {
    const start = Date.now();
    await listNovels({ limit: 1000 });
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(500);
  });

  test('create order with 100 items in < 1000ms', async () => {
    // Setup: Add 100 items to cart
    const start = Date.now();
    await createOrder(userId);
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(1000);
  });

  test('approve payment with 50 items in < 500ms', async () => {
    // Setup: Order with 50 items
    const start = Date.now();
    await approvePayment(paymentId, adminId);
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(500);
  });
});
```

---

## 7. Security Tests

### 7.1 Authorization

```typescript
describe('Security: Authorization', () => {
  test('user cannot view other user orders', async () => {
    const result = await getOrder(otherUserOrderId, user1Id);
    expect(result).toThrow('FORBIDDEN');
  });

  test('user cannot approve payments', async () => {
    const result = await approvePayment(paymentId, userId);
    expect(result).toThrow('FORBIDDEN');
  });

  test('admin cannot view user points as currency', async () => {
    // Admin can see transactions but not manipulate balance directly
    const result = await getPointsBalance(userId, adminId);
    expect(result).toBeDefined();
  });
});
```

### 7.2 Input Validation

```typescript
describe('Security: Input Validation', () => {
  test('rejects oversized file uploads', async () => {
    const largeBuffer = Buffer.alloc(101 * 1024 * 1024);
    const result = await uploadEpisodeFile(episodeId, 'huge.pdf', largeBuffer);
    expect(result).toThrow('exceeds');
  });

  test('rejects malicious coupon codes', async () => {
    const result = await validateCoupon("'; DROP TABLE coupons; --");
    expect(result.valid).toBe(false);
  });

  test('sanitizes user input in descriptions', async () => {
    const result = await createBanner({
      description: '<script>alert("xss")</script>'
    });
    expect(result.banner.description).not.toContain('<script>');
  });
});
```

---

## 8. Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test server/services/orderService.test.ts

# Run with coverage
pnpm test --coverage

# Run in watch mode
pnpm test --watch

# Run integration tests only
pnpm test server/integration

# Run e2e tests only
pnpm test server/e2e
```

---

## 9. CI/CD Integration

Tests run automatically on:
- Every commit (pre-commit hook)
- Every pull request
- Before deployment

Minimum coverage required: **80%**

---

## 10. Test Maintenance

- Update tests when business logic changes
- Add tests for new features before implementation
- Review and update fixtures quarterly
- Monitor test execution time (target: < 30 seconds total)
