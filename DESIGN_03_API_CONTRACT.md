# Ipenovel V2 - API Contract (tRPC)

## Overview

All APIs are implemented as tRPC procedures. The contract uses TypeScript for type safety end-to-end. All responses include proper error handling with descriptive messages.

**Base URL:** `/api/trpc`

**Authentication:** Manus OAuth (automatic via session cookie)

---

## Authentication & User

### `auth.me` (Query)
Get current authenticated user.

**Access:** Public (returns null if not authenticated)

**Request:**
```typescript
// No input
```

**Response:**
```typescript
interface User {
  id: number;
  openId: string;
  name?: string;
  email?: string;
  role: 'user' | 'admin';
  createdAt: Date;
  lastSignedIn: Date;
}

// Returns null if not authenticated
```

**Errors:**
- None (returns null for unauthenticated)

---

### `auth.logout` (Mutation)
Logout current user and clear session.

**Access:** Protected (authenticated users only)

**Request:**
```typescript
// No input
```

**Response:**
```typescript
{ success: true }
```

**Errors:**
- None (always succeeds)

---

## Novel & Episode Browsing

### `novels.list` (Query)
List all novels with pagination and filtering.

**Access:** Public

**Request:**
```typescript
{
  page?: number;              // Default: 1
  limit?: number;             // Default: 20, Max: 100
  search?: string;            // Search by title or author
  categoryId?: number;        // Filter by category
  status?: 'ongoing' | 'completed' | 'hiatus';
  sortBy?: 'newest' | 'popular' | 'title';
}
```

**Response:**
```typescript
{
  novels: Novel[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

interface Novel {
  id: number;
  title: string;
  slug: string;
  description?: string;
  author?: string;
  coverImageUrl?: string;
  status: 'ongoing' | 'completed' | 'hiatus';
  totalEpisodes: number;
  categories: Category[];
  createdAt: Date;
}

interface Category {
  id: number;
  name: string;
  slug: string;
}
```

**Errors:**
- None (returns empty list if no results)

---

### `novels.detail` (Query)
Get detailed information about a novel.

**Access:** Public

**Request:**
```typescript
{
  novelId: number;  // OR
  slug: string;     // Novel slug for URL-friendly access
}
```

**Response:**
```typescript
{
  novel: NovelDetail;
  episodes: EpisodeDetail[];
  userPurchases: number[];  // Episode IDs user has purchased (if authenticated)
}

interface NovelDetail extends Novel {
  description: string;
  episodes: EpisodeDetail[];
}

interface EpisodeDetail {
  id: number;
  episodeNumber: string;
  title: string;
  description?: string;
  price: Decimal;
  isFree: boolean;
  isPurchased: boolean;      // Only for authenticated users
  createdAt: Date;
}
```

**Errors:**
- `NOT_FOUND` - Novel not found

---

### `episodes.list` (Query)
List episodes of a novel with purchase status.

**Access:** Public

**Request:**
```typescript
{
  novelId: number;
  page?: number;
  limit?: number;
}
```

**Response:**
```typescript
{
  episodes: EpisodeDetail[];
  total: number;
  page: number;
  hasMore: boolean;
}
```

**Errors:**
- `NOT_FOUND` - Novel not found

---

### `episodes.detail` (Query)
Get detailed information about an episode.

**Access:** Public

**Request:**
```typescript
{
  episodeId: number;
}
```

**Response:**
```typescript
{
  episode: EpisodeDetail;
  novel: { id: number; title: string; slug: string };
  userHasAccess: boolean;    // If authenticated
}
```

**Errors:**
- `NOT_FOUND` - Episode not found

---

## Shopping Cart

### `cart.add` (Mutation)
Add episode to shopping cart.

**Access:** Protected

**Request:**
```typescript
{
  episodeId: number;
}
```

**Response:**
```typescript
{
  success: true;
  cartItem: CartItem;
  cartTotal: {
    itemCount: number;
    subtotal: Decimal;
  };
}

interface CartItem {
  episodeId: number;
  episodeTitle: string;
  price: Decimal;
  quantity: number;
}
```

**Errors:**
- `NOT_FOUND` - Episode not found
- `BAD_REQUEST` - "Episode already in cart"
- `BAD_REQUEST` - "Episode already purchased"
- `BAD_REQUEST` - "Cannot add free episodes to cart"

---

### `cart.remove` (Mutation)
Remove episode from shopping cart.

**Access:** Protected

**Request:**
```typescript
{
  episodeId: number;
}
```

**Response:**
```typescript
{
  success: true;
  cartTotal: {
    itemCount: number;
    subtotal: Decimal;
  };
}
```

**Errors:**
- `NOT_FOUND` - Episode not in cart

---

### `cart.list` (Query)
Get current shopping cart contents.

**Access:** Protected

**Request:**
```typescript
// No input
```

**Response:**
```typescript
{
  items: CartItem[];
  subtotal: Decimal;
  itemCount: number;
}
```

**Errors:**
- None (returns empty cart if no items)

---

### `cart.clear` (Mutation)
Clear all items from shopping cart.

**Access:** Protected

**Request:**
```typescript
// No input
```

**Response:**
```typescript
{
  success: true;
}
```

**Errors:**
- None (always succeeds)

---

## Checkout & Orders

### `checkout.validate` (Query)
Validate cart and calculate totals with coupon/points.

**Access:** Protected

**Request:**
```typescript
{
  couponCode?: string;
  pointsToRedeem?: number;
}
```

**Response:**
```typescript
{
  subtotal: Decimal;
  discountAmount: Decimal;
  pointsDiscount: Decimal;
  totalAmount: Decimal;
  pointsEarned: number;
  userPointsBalance: number;
  couponValid: boolean;
  couponDescription?: string;
  errors: string[];          // Validation errors
}
```

**Errors:**
- `BAD_REQUEST` - "Cart is empty"
- `BAD_REQUEST` - "Coupon not found or expired"
- `BAD_REQUEST` - "Coupon minimum purchase not met"
- `BAD_REQUEST` - "Insufficient points balance"

---

### `checkout.create` (Mutation)
Create order from cart contents.

**Access:** Protected

**Request:**
```typescript
{
  couponCode?: string;
  pointsToRedeem?: number;
}
```

**Response:**
```typescript
{
  order: OrderDetail;
  paymentRequired: boolean;
}

interface OrderDetail {
  id: number;
  orderNumber: string;
  subtotalAmount: Decimal;
  discountAmount: Decimal;
  pointsDiscount: Decimal;
  totalAmount: Decimal;
  pointsEarned: number;
  items: OrderItem[];
  status: 'pending';
  createdAt: Date;
}

interface OrderItem {
  id: number;
  episodeId: number;
  episodeTitle: string;
  originalPrice: Decimal;
  finalPrice: Decimal;
}
```

**Errors:**
- `BAD_REQUEST` - "Cart is empty"
- `BAD_REQUEST` - "Cart contains already purchased episodes"
- `BAD_REQUEST` - "Coupon validation failed"
- `INTERNAL_SERVER_ERROR` - "Failed to create order"

**Side Effects:**
- Cart cleared after successful order creation
- Points deducted from user balance
- Coupon usage count incremented

---

## Orders & Payments

### `orders.list` (Query)
Get user's order history.

**Access:** Protected

**Request:**
```typescript
{
  page?: number;
  limit?: number;
  status?: 'pending' | 'approved' | 'rejected';
}
```

**Response:**
```typescript
{
  orders: OrderDetail[];
  total: number;
  page: number;
  hasMore: boolean;
}
```

**Errors:**
- None (returns empty list if no orders)

---

### `orders.detail` (Query)
Get detailed information about an order.

**Access:** Protected (user can only view their own orders)

**Request:**
```typescript
{
  orderId: number;
}
```

**Response:**
```typescript
{
  order: OrderDetail;
  payment: PaymentDetail;
}

interface PaymentDetail {
  id: number;
  status: 'pending' | 'approved' | 'rejected';
  slipImageUrl?: string;
  rejectionReason?: string;
  createdAt: Date;
}
```

**Errors:**
- `NOT_FOUND` - Order not found
- `FORBIDDEN` - User does not own this order

---

### `orders.uploadSlip` (Mutation)
Upload payment slip image for an order.

**Access:** Protected

**Request:**
```typescript
{
  orderId: number;
  slipImageBase64: string;   // Base64-encoded image
  mimeType: string;          // "image/jpeg", "image/png"
}
```

**Response:**
```typescript
{
  success: true;
  payment: PaymentDetail;
}
```

**Errors:**
- `NOT_FOUND` - Order not found
- `FORBIDDEN` - User does not own this order
- `BAD_REQUEST` - "Order already approved/rejected"
- `BAD_REQUEST` - "Invalid image format"
- `BAD_REQUEST` - "Image too large (max 5MB)"

**Side Effects:**
- Payment slip uploaded to S3
- Payment record updated with slip URL

---

## My Novels (Purchased Content)

### `myNovels.list` (Query)
Get user's purchased novels grouped by novel.

**Access:** Protected

**Request:**
```typescript
{
  page?: number;
  limit?: number;
}
```

**Response:**
```typescript
{
  novels: MyNovelDetail[];
  total: number;
  page: number;
}

interface MyNovelDetail {
  novel: {
    id: number;
    title: string;
    slug: string;
    coverImageUrl?: string;
  };
  episodes: MyEpisodeDetail[];
  purchaseCount: number;
}

interface MyEpisodeDetail {
  id: number;
  episodeNumber: string;
  title: string;
  purchasedAt: Date;
  canDownload: boolean;
  canRead: boolean;
}
```

**Errors:**
- None (returns empty list if no purchases)

---

### `myNovels.downloadUrl` (Query)
Get pre-signed download URL for an episode.

**Access:** Protected (user must own the episode)

**Request:**
```typescript
{
  episodeId: number;
  expiresIn?: number;  // Seconds (default: 3600, max: 86400)
}
```

**Response:**
```typescript
{
  downloadUrl: string;  // Pre-signed S3 URL
  expiresAt: Date;
  fileName: string;
}
```

**Errors:**
- `NOT_FOUND` - Episode not found
- `FORBIDDEN` - User does not own this episode
- `BAD_REQUEST` - "Episode file not available"

---

## Points System

### `points.balance` (Query)
Get user's current points balance.

**Access:** Protected

**Request:**
```typescript
// No input
```

**Response:**
```typescript
{
  balance: number;
  currencyEquivalent: Decimal;  // balance * 1
}
```

**Errors:**
- None (returns 0 if no transactions)

---

### `points.history` (Query)
Get user's points transaction history.

**Access:** Protected

**Request:**
```typescript
{
  page?: number;
  limit?: number;
  transactionType?: 'earn' | 'redeem' | 'admin';
}
```

**Response:**
```typescript
{
  transactions: PointsTransaction[];
  total: number;
  page: number;
}

interface PointsTransaction {
  id: number;
  transactionType: 'earn' | 'redeem' | 'admin';
  pointsAmount: number;
  description: string;
  relatedOrderNumber?: string;
  createdAt: Date;
}
```

**Errors:**
- None (returns empty list if no transactions)

---

## Wishlist

### `wishlist.add` (Mutation)
Add episode to wishlist.

**Access:** Protected

**Request:**
```typescript
{
  episodeId: number;
}
```

**Response:**
```typescript
{
  success: true;
  wishlistCount: number;
}
```

**Errors:**
- `NOT_FOUND` - Episode not found
- `BAD_REQUEST` - "Episode already in wishlist"

---

### `wishlist.remove` (Mutation)
Remove episode from wishlist.

**Access:** Protected

**Request:**
```typescript
{
  episodeId: number;
}
```

**Response:**
```typescript
{
  success: true;
  wishlistCount: number;
}
```

**Errors:**
- `NOT_FOUND` - Episode not in wishlist

---

### `wishlist.list` (Query)
Get user's wishlist.

**Access:** Protected

**Request:**
```typescript
{
  page?: number;
  limit?: number;
}
```

**Response:**
```typescript
{
  items: WishlistItem[];
  total: number;
  page: number;
}

interface WishlistItem {
  id: number;
  episode: {
    id: number;
    episodeNumber: string;
    title: string;
    price: Decimal;
  };
  novel: {
    id: number;
    title: string;
    slug: string;
  };
  addedAt: Date;
}
```

**Errors:**
- None (returns empty list if no items)

---

## Admin: Payment Verification

### `admin.payments.pending` (Query)
Get pending payments for admin review.

**Access:** Admin only

**Request:**
```typescript
{
  limit?: number;  // Default: 50
}
```

**Response:**
```typescript
{
  payments: AdminPaymentDetail[];
}

interface AdminPaymentDetail {
  id: number;
  order: {
    id: number;
    orderNumber: string;
    userId?: number;
    totalAmount: Decimal;
    items: OrderItem[];
  };
  slipImageUrl?: string;
  createdAt: Date;
}
```

**Errors:**
- `FORBIDDEN` - User is not admin

---

### `admin.payments.approve` (Mutation)
Approve a pending payment.

**Access:** Admin only

**Request:**
```typescript
{
  paymentId: number;
}
```

**Response:**
```typescript
{
  success: true;
  payment: AdminPaymentDetail;
  purchasesCreated: number;
  pointsAwarded: number;
}
```

**Errors:**
- `NOT_FOUND` - Payment not found
- `FORBIDDEN` - User is not admin
- `BAD_REQUEST` - "Payment already approved"
- `BAD_REQUEST` - "Payment has been rejected"

**Side Effects:**
- Payment status set to 'approved'
- Purchase entitlements created for each order item
- Points earned and added to user balance
- Order status updated to 'approved'
- OrderHistory entry created

**Idempotency:**
- Approving twice returns success but doesn't duplicate purchases/points

---

### `admin.payments.reject` (Mutation)
Reject a pending payment.

**Access:** Admin only

**Request:**
```typescript
{
  paymentId: number;
  rejectionReason: string;
}
```

**Response:**
```typescript
{
  success: true;
  payment: AdminPaymentDetail;
}
```

**Errors:**
- `NOT_FOUND` - Payment not found
- `FORBIDDEN` - User is not admin
- `BAD_REQUEST` - "Payment already rejected"
- `BAD_REQUEST` - "Rejection reason required"

**Side Effects:**
- Payment status set to 'rejected'
- Order status updated to 'rejected'
- rejectionReason recorded
- OrderHistory entry created
- No purchases created
- No points awarded

---

## Admin: Orders

### `admin.orders.list` (Query)
Get all orders for admin review.

**Access:** Admin only

**Request:**
```typescript
{
  page?: number;
  limit?: number;
  status?: 'pending' | 'approved' | 'rejected';
  userId?: number;
}
```

**Response:**
```typescript
{
  orders: AdminOrderDetail[];
  total: number;
  page: number;
}

interface AdminOrderDetail {
  id: number;
  orderNumber: string;
  userId?: number;
  totalAmount: Decimal;
  status: 'pending' | 'approved' | 'rejected';
  items: OrderItem[];
  payment: PaymentDetail;
  createdAt: Date;
}
```

**Errors:**
- `FORBIDDEN` - User is not admin

---

## Admin: Banners

### `admin.banners.list` (Query)
Get all banners.

**Access:** Admin only

**Request:**
```typescript
// No input
```

**Response:**
```typescript
{
  banners: BannerDetail[];
}

interface BannerDetail {
  id: number;
  title: string;
  description?: string;
  imageUrl: string;
  linkUrl?: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: Date;
}
```

**Errors:**
- `FORBIDDEN` - User is not admin

---

### `admin.banners.create` (Mutation)
Create a new banner.

**Access:** Admin only

**Request:**
```typescript
{
  title: string;
  description?: string;
  imageUrl: string;      // S3 URL
  linkUrl?: string;
  displayOrder?: number;
}
```

**Response:**
```typescript
{
  success: true;
  banner: BannerDetail;
}
```

**Errors:**
- `FORBIDDEN` - User is not admin
- `BAD_REQUEST` - "Title required"
- `BAD_REQUEST` - "Image URL required"

---

### `admin.banners.delete` (Mutation)
Delete a banner.

**Access:** Admin only

**Request:**
```typescript
{
  bannerId: number;
}
```

**Response:**
```typescript
{
  success: true;
}
```

**Errors:**
- `FORBIDDEN` - User is not admin
- `NOT_FOUND` - Banner not found

---

## Admin: Coupons

### `admin.coupons.list` (Query)
Get all coupons.

**Access:** Admin only

**Request:**
```typescript
// No input
```

**Response:**
```typescript
{
  coupons: CouponDetail[];
}

interface CouponDetail {
  id: number;
  code: string;
  discountType: 'flat' | 'percentage';
  discountValue: Decimal;
  minPurchaseAmount: Decimal;
  maxUsageCount?: number;
  usageCount: number;
  isActive: boolean;
  expiresAt?: Date;
  createdAt: Date;
}
```

**Errors:**
- `FORBIDDEN` - User is not admin

---

### `admin.coupons.create` (Mutation)
Create a new coupon.

**Access:** Admin only

**Request:**
```typescript
{
  code: string;
  discountType: 'flat' | 'percentage';
  discountValue: Decimal;
  minPurchaseAmount?: Decimal;
  maxUsageCount?: number;
  expiresAt?: Date;
}
```

**Response:**
```typescript
{
  success: true;
  coupon: CouponDetail;
}
```

**Errors:**
- `FORBIDDEN` - User is not admin
- `BAD_REQUEST` - "Code required"
- `BAD_REQUEST` - "Code already exists"
- `BAD_REQUEST` - "Discount value must be > 0"

---

## File Management

### `files.getDownloadUrl` (Query)
Get pre-signed download URL for an episode (same as `myNovels.downloadUrl`).

**Access:** Protected

**Request:**
```typescript
{
  episodeId: number;
  expiresIn?: number;
}
```

**Response:**
```typescript
{
  downloadUrl: string;
  expiresAt: Date;
}
```

**Errors:**
- `FORBIDDEN` - User does not own this episode
- `NOT_FOUND` - Episode not found

---

## Error Response Format

All errors follow this format:

```typescript
{
  code: string;              // tRPC error code
  message: string;           // Human-readable error message
  data?: {
    code: string;            // Detailed error code
    httpStatus: number;      // HTTP status code
    path: string;            // tRPC procedure path
  };
}
```

**Common Error Codes:**
- `UNAUTHORIZED` - User not authenticated
- `FORBIDDEN` - User lacks permission
- `NOT_FOUND` - Resource not found
- `BAD_REQUEST` - Invalid input
- `CONFLICT` - Resource already exists
- `INTERNAL_SERVER_ERROR` - Server error

---

## Response Format

All successful responses are automatically serialized with SuperJSON, which means:
- `Date` objects remain as `Date` (not strings)
- `Decimal` values properly serialized
- `BigInt` supported
- Custom types preserved end-to-end

---

## Rate Limiting & Quotas

- No explicit rate limiting (rely on Manus platform)
- Cart limited to 100 items
- Order history paginated (max 100 per page)
- File uploads limited to 5MB

---

## Versioning

All APIs are versioned at the tRPC level. Breaking changes will increment the version (e.g., `v2`).

Current version: `v1` (implicit)
