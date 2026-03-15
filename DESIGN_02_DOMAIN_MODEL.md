# Ipenovel V2 - Domain Model

## Core Concepts

The domain model is organized around **four key aggregates**: **User**, **Novel**, **Order**, and **Purchase**. Each aggregate owns its related entities and enforces business rules.

---

## Aggregate 1: User

**Root Entity:** `User`

### Definition
A user account in the system with authentication, role-based access, and transactional history.

### Owned Entities
- Cart (shopping cart session)
- CartItems (items in cart)
- Orders (purchase history)
- Purchases (content entitlements)
- PointsTransactions (rewards history)
- WishlistItems (saved for later)

### Key Properties
```typescript
interface User {
  id: number;                    // Surrogate key
  openId: string;                // Manus OAuth identifier (unique)
  name?: string;
  email?: string;
  role: 'user' | 'admin';        // Access level
  createdAt: Date;
  lastSignedIn: Date;
}
```

### Business Rules
1. **One openId per user** - Enforced by unique constraint
2. **Owner is admin** - User with ENV.OWNER_OPEN_ID automatically promoted to admin
3. **Role immutable** - Admins can only be changed via database
4. **One active cart** - User can have only one active shopping cart at a time

### Relationships
```
User
├── Cart (1:1 active)
│   └── CartItems (1:N)
├── Orders (1:N)
│   └── OrderItems (1:N)
├── Purchases (1:N) ← SOURCE OF TRUTH FOR ACCESS
├── PointsTransactions (1:N)
└── WishlistItems (1:N)
```

---

## Aggregate 2: Novel

**Root Entity:** `Novel`

### Definition
A published work of fiction with metadata, episodes, and categorization.

### Owned Entities
- Episodes (chapters/installments)
- NovelCategories (category assignments)

### Key Properties
```typescript
interface Novel {
  id: number;
  title: string;
  slug: string;                  // URL-friendly identifier
  description?: string;
  author?: string;
  coverImageUrl?: string;        // S3 URL
  status: 'ongoing' | 'completed' | 'hiatus';
  totalEpisodes: number;         // Auto-updated
  createdAt: Date;
}
```

### Business Rules
1. **Unique slug** - Enforced by unique constraint
2. **Episodes immutable** - Once published, episode metadata cannot change (new version = new episode)
3. **Multiple categories** - Novel can belong to multiple categories
4. **Cover image in S3** - All images stored in S3, not in database

### Episode Structure
```typescript
interface Episode {
  id: number;
  novelId: number;
  episodeNumber: string;         // "1", "2", "3-5" (range), "581-619"
  title: string;
  price: Decimal;                // In currency units (฿)
  isFree: boolean;               // Free episodes always have price = 0
  fileUrl?: string;              // S3 URL to PDF/EPUB/etc.
  fileKey?: string;              // S3 key for deletion
  viewCount: number;
}
```

### Episode Business Rules
1. **Unique episode number per novel** - Enforced by unique constraint on (novelId, episodeNumber)
2. **Free episodes have zero price** - Enforced in application layer
3. **Episode number can be range** - Supports multi-episode files (e.g., "581-619")
4. **File URL immutable** - Once uploaded, cannot be changed (delete and re-upload if needed)
5. **Free episodes accessible to all** - No purchase required

### Relationships
```
Novel
├── Episodes (1:N)
│   ├── OrderItems (1:N) ← Links to orders
│   ├── Purchases (1:N) ← Links to user entitlements
│   └── WishlistItems (1:N)
└── NovelCategories (1:N)
    └── Categories (N:M)
```

---

## Aggregate 3: Order

**Root Entity:** `Order`

### Definition
A customer's purchase transaction containing one or more episodes, with payment tracking and admin review.

### Owned Entities
- OrderItems (episodes in this order)
- Payment (payment record and admin review state)
- OrderHistory (audit log)

### Key Properties
```typescript
interface Order {
  id: number;
  userId?: number;               // Nullable for test data
  orderNumber: string;           // "ORD-20260315-ABC123" (unique, immutable)
  subtotalAmount: Decimal;       // Sum of item prices
  discountAmount: Decimal;       // Coupon discount
  pointsRedeemed: number;        // Points used
  pointsDiscount: Decimal;       // Currency value of points
  totalAmount: Decimal;          // Final amount to pay
  status: 'pending' | 'approved' | 'rejected';
  couponCode?: string;
  createdAt: Date;
}
```

### Order Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    ORDER LIFECYCLE                          │
└─────────────────────────────────────────────────────────────┘

1. CREATION (Customer)
   ├─ User adds items to cart
   ├─ User applies coupon (optional)
   ├─ User redeems points (optional)
   └─ User clicks "Checkout"
      └─ Order created with status = 'pending'
         └─ OrderItems created for each cart item
         └─ Payment record created with status = 'pending'

2. PAYMENT SUBMISSION (Customer)
   ├─ Customer uploads payment slip image
   └─ Slip stored in S3, URL saved in Payment record

3. ADMIN REVIEW (Admin)
   ├─ Admin views pending payments
   ├─ Admin verifies payment slip
   └─ Admin chooses: APPROVE or REJECT

4A. APPROVAL PATH
    ├─ Payment.status = 'approved'
    ├─ Order.status = 'approved'
    ├─ Purchase entitlements created for each episode
    ├─ Points earned and added to user balance
    └─ Order complete - Customer can access content

4B. REJECTION PATH
    ├─ Payment.status = 'rejected'
    ├─ Order.status = 'rejected'
    ├─ rejectionReason recorded
    ├─ No purchases created
    ├─ No points earned
    └─ Customer can retry with new order
```

### Order Items
```typescript
interface OrderItem {
  id: number;
  orderId: number;
  episodeId: number;
  originalPrice: Decimal;        // Episode price at purchase time
  finalPrice: Decimal;           // After discount
}
```

### Business Rules
1. **One orderNumber per order** - Generated once, immutable
2. **Multi-item orders** - Single order can contain multiple episodes
3. **Discount calculation** - totalAmount = subtotalAmount - discountAmount - pointsDiscount
4. **Status immutable** - Once approved/rejected, cannot change
5. **Coupon applied once** - Coupon code recorded for audit trail
6. **Points tracked** - Points redeemed recorded for audit trail

### Relationships
```
Order
├── OrderItems (1:N)
│   └── Episodes (N:1)
├── Payment (1:1)
│   ├── PaymentSlip (S3)
│   └── AdminReview
├── Purchases (1:N) ← Created on approval
│   └── User access entitlements
└── OrderHistory (1:N) ← Audit log
```

---

## Aggregate 4: Purchase (Entitlement)

**Root Entity:** `Purchase`

### Definition
**SOURCE OF TRUTH FOR CONTENT ACCESS** - A user's right to access a specific episode.

### Key Properties
```typescript
interface Purchase {
  id: number;
  userId: number;
  episodeId: number;
  orderId: number;               // Which order granted this access
  purchaseType: 'paid' | 'free'; // How acquired
  grantedAt: Date;               // When access was granted
  expiresAt?: Date;              // Optional expiration
}
```

### Access Control Logic

```typescript
// Check if user can access episode
async function canAccessEpisode(userId: number, episodeId: number): Promise<boolean> {
  const episode = await getEpisode(episodeId);
  
  // Free episodes accessible to all
  if (episode.isFree) return true;
  
  // Check for purchase entitlement
  const purchase = await getPurchase(userId, episodeId);
  if (!purchase) return false;
  
  // Check expiration
  if (purchase.expiresAt && purchase.expiresAt < now()) return false;
  
  return true;
}
```

### Business Rules
1. **Unique per user-episode** - Enforced by unique constraint on (userId, episodeId)
2. **Idempotent creation** - Approving same payment twice doesn't create duplicate purchase
3. **Immutable** - Once created, purchase cannot be modified or deleted
4. **Optional expiration** - Purchases can be permanent or time-limited
5. **Free episodes** - Free episodes create purchases automatically on first view (future feature)

### Why Separate from Order?

**Order** = Transaction record (what customer bought, how much they paid)
**Purchase** = Access control (what customer can access)

Separation allows:
- Multiple episodes in one order
- Flexible access control (expiration, revocation)
- Clear audit trail (order history vs. access history)
- Future features (gift purchases, subscriptions, revocation)

### Relationships
```
Purchase (Entitlement)
├── User (N:1)
├── Episode (N:1)
└── Order (N:1) ← Links back to purchase transaction
```

---

## Aggregate 5: Payment

**Root Entity:** `Payment`

### Definition
Payment record and admin review state for an order.

### Key Properties
```typescript
interface Payment {
  id: number;
  orderId: number;               // One payment per order
  status: 'pending' | 'approved' | 'rejected';
  slipImageUrl?: string;         // S3 URL to payment slip
  slipImageKey?: string;         // S3 key for deletion
  rejectionReason?: string;      // Why rejected
  approvedAt?: Date;
  approvedBy?: number;           // Admin user ID
  rejectedAt?: Date;
  rejectedBy?: number;           // Admin user ID
}
```

### Business Rules
1. **One payment per order** - Enforced by unique constraint
2. **Immutable slip** - Once uploaded, slip image cannot be changed
3. **Rejection reason required** - If rejected, reason must be provided
4. **Approval idempotent** - Approving same payment twice doesn't duplicate purchases/points
5. **Admin audit trail** - Track which admin approved/rejected and when

### Idempotency Protection

```typescript
// Approval is idempotent
async function approvePayment(paymentId: number, adminId: number) {
  const payment = await getPayment(paymentId);
  
  // If already approved, return success (idempotent)
  if (payment.status === 'approved') {
    return { success: true, alreadyApproved: true };
  }
  
  // If rejected, cannot re-approve (business rule)
  if (payment.status === 'rejected') {
    throw new Error('Cannot approve rejected payment');
  }
  
  // Approve payment and grant purchases
  await updatePaymentStatus(paymentId, 'approved', adminId);
  
  // Grant purchases (idempotent via unique constraint)
  const order = await getOrder(payment.orderId);
  for (const item of order.items) {
    await createPurchase({
      userId: order.userId,
      episodeId: item.episodeId,
      orderId: order.id,
      purchaseType: 'paid'
    });
  }
  
  // Award points (idempotent via transaction record)
  const pointsEarned = Math.floor(order.totalAmount / 100);
  await createPointsTransaction({
    userId: order.userId,
    orderId: order.id,
    transactionType: 'earn',
    pointsAmount: pointsEarned,
    description: `Earned from order ${order.orderNumber}`
  });
}
```

### Relationships
```
Payment
├── Order (1:1)
│   └── OrderItems
├── PaymentSlip (S3)
└── AdminReview
    ├── ApprovedBy (User)
    └── RejectedBy (User)
```

---

## Supporting Aggregates

### Cart
```typescript
interface Cart {
  id: number;
  userId: number;
  sessionId: string;             // For idempotency
  items: CartItem[];
}

interface CartItem {
  episodeId: number;
  price: Decimal;
  quantity: number;              // Usually 1
}
```

**Rules:**
- One active cart per user
- Cannot add already-purchased episodes
- Cannot add duplicate episodes
- Cart cleared after order creation

### Coupon
```typescript
interface Coupon {
  code: string;
  discountType: 'flat' | 'percentage';
  discountValue: Decimal;
  minPurchaseAmount: Decimal;
  maxUsageCount?: number;
  usageCount: number;
  isActive: boolean;
  expiresAt?: Date;
}
```

**Validation Rules:**
- Must be active
- Must not be expired
- Must not exceed usage limit
- Order total must meet minimum
- Can only be applied once per order

### Points System
```typescript
// Conversion rates
const POINTS_PER_CURRENCY = 1 / 100;  // 100 currency = 1 point (earn)
const CURRENCY_PER_POINT = 1;         // 1 point = 1 currency (redeem)

// Example
const orderTotal = 500;               // ฿500
const pointsEarned = 5;               // 500 * (1/100) = 5 points
const pointsRedeemed = 50;            // User uses 50 points
const currencyDiscount = 50;          // 50 * 1 = ฿50
```

---

## Entity Relationships Summary

```
┌────────────────────────────────────────────────────────────┐
│                    ENTITY RELATIONSHIPS                    │
└────────────────────────────────────────────────────────────┘

User (1)
├── Cart (1) ──┬─→ CartItem (N) ──→ Episode
│              └─→ (cleared on checkout)
│
├── Order (N) ──┬─→ OrderItem (N) ──→ Episode
│               ├─→ Payment (1) ──→ PaymentSlip (S3)
│               └─→ OrderHistory (N)
│
├── Purchase (N) ──→ Episode (N)
│                    ↑
│                    └─ SOURCE OF TRUTH FOR ACCESS
│
├── PointsTransaction (N)
│
└── WishlistItem (N) ──→ Episode

Novel (1)
├── Episode (N)
│   ├── OrderItem (N)
│   ├── Purchase (N)
│   └── WishlistItem (N)
│
└── NovelCategory (N) ──→ Category

Coupon (1)
├── Order (N) [via couponCode]
└── CouponUsage (N)

Banner (1)
└── [displayed on home page]

Settings (1)
└── [site configuration]
```

---

## Key Design Principles

1. **Aggregates Own Their Data** - Each aggregate controls its entities
2. **Purchases = Access Control** - Not orders, not payments
3. **Immutability** - Critical data (orderNumber, purchases) cannot change
4. **Idempotency** - Operations safe to retry (unique constraints, status checks)
5. **Audit Trail** - All state changes logged in orderHistory
6. **S3 for Files** - Database stores URLs, S3 stores actual files
7. **Separation of Concerns** - Order (transaction) ≠ Payment (admin review) ≠ Purchase (access)
8. **Nullable Foreign Keys** - Support test data and edge cases
9. **Enum Types** - Enforce valid values at database level
10. **Timestamps** - All times UTC for consistency

---

## Future Extensibility

### Subscriptions
```typescript
interface Subscription {
  userId: number;
  planId: number;
  startDate: Date;
  endDate: Date;
  autoRenew: boolean;
}
```

### Series/Collections
```typescript
interface Series {
  id: number;
  name: string;
  novels: Novel[];  // Multiple novels grouped
}
```

### Reading Progress
```typescript
interface ReadingProgress {
  userId: number;
  episodeId: number;
  lastReadAt: Date;
  progressPercentage: number;
}
```

### Reviews & Ratings
```typescript
interface Review {
  userId: number;
  episodeId: number;
  rating: 1 | 2 | 3 | 4 | 5;
  comment: string;
}
```
