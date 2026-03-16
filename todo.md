# Ipenovel V2 - Project TODO

## Database & Core Infrastructure
- [x] Design and implement database schema (18 tables)
- [x] Create database migrations
- [x] Add database query helpers in server/db.ts

## Backend API Routes & Services
- [x] Implement auth integration with Manus OAuth
- [x] Build novels and episodes browsing APIs
- [x] Build cart management APIs (add, remove, list)
- [x] Build checkout and order creation APIs
- [x] Build payment slip upload API
- [x] Build payment approval/rejection APIs (admin)
- [x] Build purchase entitlement APIs
- [x] Build My Novels APIs
- [x] Build download/read access verification APIs
- [x] Build wishlist APIs
- [x] Build points system APIs (balance, history, redemption)
- [x] Build coupon validation APIs
- [x] Build admin content management APIs (novels, episodes, categories, banners, coupons)
- [x] Build admin order review APIs
- [x] Build admin settings APIs
- [x] Implement service layer for business logic
- [x] Add transaction support for critical flows

## Frontend - Customer Pages
- [x] Design and implement Home/Landing page
- [x] Build Novel Listing page with search and filters
- [ ] Build Novel Detail page (with free/paid episodes)
- [ ] Build Episode Reader/View page
- [x] Build Shopping Cart page
- [ ] Build Checkout page with coupon and points
- [ ] Build Payment Submission page (slip upload)
- [x] Build Orders/Order History page
- [x] Build My Novels page (purchased content)
- [ ] Build Wishlist page
- [ ] Build Profile/Account page
- [x] Build Points/Rewards page

## Frontend - Admin Pages
- [x] Build Admin Dashboard
- [ ] Build Admin Novels Management page
- [ ] Build Admin Episodes Management page
- [ ] Build Admin Categories Management page
- [x] Build Admin Banners Management page
- [x] Build Admin Coupons Management page (with full CRUD: create, read, update, delete)
- [x] Build Admin Payment Verification page
- [ ] Build Admin Order Details page
- [ ] Build Admin Settings page

## S3 File Storage & Downloads
- [x] Implement S3 file upload for episode files
- [x] Implement pre-signed URL generation for downloads
- [x] Implement entitlement-based access control
- [x] Build download endpoint with authorization checks

## Features - Commerce
- [x] Implement cart logic (prevent duplicates, prevent already purchased)
- [x] Implement multi-item checkout (create order + orderItems)
- [x] Implement order number generation (unique, idempotent)
- [x] Implement payment slip upload and storage
- [x] Implement admin payment approval with idempotency
- [x] Implement purchase entitlement granting
- [x] Implement coupon validation and application
- [x] Implement points earning and redemption
- [x] Implement order history/audit logging

## Features - Content Access
- [x] Implement purchase entitlement verification
- [x] Implement My Novels grouping by novel
- [x] Implement download access restrictions
- [x] Implement read access restrictions

## Testing & Quality
- [x] Write vitest tests for order creation (multi-item)
- [x] Write vitest tests for order number generation
- [x] Write vitest tests for payment approval idempotency
- [x] Write vitest tests for purchase entitlement
- [x] Write vitest tests for coupon application
- [x] Write vitest tests for points system
- [x] Write vitest tests for authorization checks
- [x] Write vitest tests for cart logic
- [ ] Write integration tests for critical flows

## Seed Data & Demo
- [x] Create seed script for sample novels
- [x] Create seed script for sample episodes (free + paid)
- [x] Create seed script for sample categories
- [x] Create seed script for sample banners
- [x] Create seed script for sample coupons
- [ ] Create seed script for sample admin account

## Documentation & Delivery
- [ ] Write README with local setup instructions
- [ ] Document architecture overview
- [ ] Document order/payment/purchase lifecycle
- [ ] Document assumptions made during implementation
- [ ] Create API documentation
- [ ] Add code comments for complex business logic

## Polish & Optimization
- [ ] Test responsive design across devices
- [ ] Test cross-browser compatibility
- [ ] Optimize database queries
- [ ] Add proper error handling and user feedback
- [ ] Implement loading states and empty states
- [ ] Add accessibility features
- [ ] Performance testing and optimization


## Payment Flow - QR Code & Slip Upload
- [x] Upload QR payment image to S3
- [x] Create PaymentPage component with QR display
- [x] Add payment page route to App.tsx
- [x] Update CartPage checkout to redirect to payment page
- [x] Add slip upload functionality to PaymentPage
- [x] Add Thai translations for payment flow
- [ ] Test payment flow with paid episodes
- [ ] Test free episodes bypass payment
- [ ] Verify admin approval flow still works
- [ ] Run regression tests


## UI/UX Redesign - Mobile-First Navbar & Home Page
- [x] Redesign Navbar with pill-style navigation and mobile-first layout
- [x] Redesign Home page hero section with strong blue banner
- [x] Redesign Home page content sections and novel cards
- [x] Update shared styles for better visual consistency
- [ ] Test responsive design on mobile, tablet, desktop
- [ ] Verify no regression in auth, orders, payments, purchases, My Novels, points


## Order Fixes - orderNumber Format & View Details
- [x] Implement MMDDNNN orderNumber format with daily reset
- [x] Fix View Details button on Orders page
- [x] Verify order detail page routing
- [x] Test orderNumber format and concurrent creation
- [x] Test View Details button navigation
- [x] Verify no regression in order/payment flows


## Orders & My Novels UI Updates
- [x] Update Orders page to show episodeNumber and title
- [x] Update My Novels page to remove Download button
- [x] Make Read button primary action with fileUrl linking
- [x] Verify API responses include episodeNumber, title, fileUrl
- [x] Add fileUrl fallback handling
- [x] Test Orders and My Novels pages
- [ ] Run regression tests for orders/purchases/My Novels


## Payment Status Sync & Rejection Flow Fix
- [ ] Fix backend rejection bug in orderService.rejectPayment
- [ ] Implement payment/order status sync on slip upload
- [ ] Implement payment/order status sync on approval
- [ ] Implement payment/order status sync on rejection
- [ ] Update PaymentPage UX for rejected/pending/approved states
- [ ] Update OrdersPage to show correct statuses and rejection reasons
- [ ] Update OrderDetailPage to show correct statuses and rejection reasons
- [ ] Add/update tests for payment status sync
- [ ] Run regression tests for payment/order flows


## Admin Novel Management Fixes
- [ ] Fix broken image URL handling with validation and placeholders
- [ ] Make admin novels truly editable with update mutation
- [ ] Create AdminNovelManagePage for dedicated novel management
- [ ] Update AdminEpisodesPage to support scoped mode per novel
- [ ] Fix AdminNovelsPage table/list and add Manage button
- [ ] Add routes and integrate all changes
- [ ] Test admin novel management flow end-to-end
- [ ] Verify no regression in core flows


## Payment Slip Re-Upload Dead-End Fix
- [x] Analyze payment page flow and identify dead-end issue
- [x] Ensure PaymentPage loads existing order/payment by route param
- [x] Update PaymentPage upload UI based on payment status
- [x] Fix back navigation to not invalidate upload ability
- [ ] Add resume-payment entry point from OrdersPage/OrderDetailPage
- [ ] Test payment re-upload flow with back navigation
- [ ] Test refresh and browser back behavior
- [ ] Run regression tests for orders/payments/purchases flows


## Admin Coupons CRUD Implementation
- [x] Add updateCoupon and deleteCoupon functions to server/db.ts
- [x] Add update and delete TRPC procedures to admin.coupons router
- [x] Implement AdminCouponsPage with full CRUD UI
- [x] Add edit button handler with form population
- [x] Add delete button with confirmation dialog
- [x] Fix form state management between create/edit modes
- [x] Implement date serialization/parsing for existing coupons
- [x] Add numeric field validation
- [x] Write comprehensive vitest for coupon CRUD functions (21 tests passing)
- [x] Verify backend procedures work correctly
- [x] Verify no regressions in core flows (coupon tests passing)


## Admin Bulk Upload CSV File Support
- [x] Create CSV parser helper with file upload support (client/src/lib/csvParser.ts)
- [x] Add CSV file upload button to AdminBulkUploadPage (novels tab)
- [x] Add CSV file upload button to AdminBulkUploadPage (episodes tab - by title mode)
- [x] Add CSV file upload button to AdminBulkUploadPage (episodes tab - manual mode)
- [x] Integrate CSV parser with existing bulk upload validation pipeline
- [x] Support Thai characters in CSV parsing
- [x] Keep episodeNumber as string (not number)
- [x] Show selected filename and loading state during parsing
- [x] Display clear error messages for invalid CSV
- [x] Write comprehensive vitest for CSV parser (15 tests passing)
- [x] Verify existing manual bulk upload flow still works
- [x] No architecture changes - reused existing bulk upload pipeline


## Bug Fixes
- [x] Fix coupon validation to handle null/empty discountValue (server/services/orderService.ts)
- [x] Add validation for percentage discount range (0-100)
- [x] Update NEWZ coupon with valid discount value (15%)
- [x] All coupon validation tests passing (13/13)


## Coupon Serialization & Validation Fix
- [x] Fix admin coupons list query to normalize decimal fields (discountValue, minPurchaseAmount)
- [x] Normalize numeric fields in AdminCouponsPage form/state
- [x] Improve coupon validation error handling with specific error messages
- [x] All coupon validation tests passing (13/13)
- [x] discountValue now displays correctly in admin coupons table
- [x] Coupon validation no longer fails with generic "invalid" error


## Admin Payment Review UI Improvement
- [x] Update admin payments query to include buyer user data (name, email)
- [x] Create SlipPreviewModal component for viewing payment slips
- [x] Redesign AdminPaymentsPage to display buyer info prominently
- [x] Add slip preview functionality (thumbnail + View Full button)
- [x] Show "No slip uploaded" state for payments without slips
- [x] Preserve approve/reject functionality
- [x] All payment tests passing (13/13)


## Coupon System End-to-End Fix
- [x] Create coupon normalizer helper for consistent data handling (server/helpers/couponHelper.ts)
- [x] Fix coupon lookup to handle case/whitespace normalization (getCouponByCode)
- [x] Fix coupon validation logic with specific error messages (validateAndApplyCoupon)
- [x] Update admin coupon endpoints to use normalizer (admin.coupons.list)
- [x] Fix AdminCouponsPage form state and rendering
- [x] Fix CartPage to show real coupon error messages instead of generic "Invalid coupon"
- [x] Add comprehensive coupon tests for all scenarios (server/coupon.test.ts)
- [x] Verify no regressions in payment/order flows (auth.logout.test.ts passing)


## React Error #321 Fix
- [x] Audit React and React-DOM versions (no duplicates/mismatches found)
- [x] Audit App.tsx for hook violations (no violations found)
- [x] Audit admin pages for hook violations (no violations found)
- [x] Audit PaymentPage for hook violations (no violations found)
- [x] Audit admin components for hook violations (no violations found)
- [x] Fix AdminPaymentsPage import path for useAuth
- [x] Verify dev server running without React errors


## React Error #321 Fix - CartPage
- [x] Move trpc.useUtils() from event handler to component top level
- [x] Update handleValidateCoupon to use top-level utils instance
- [x] Verify CartPage renders without React error #321
- [x] Verify coupon apply functionality still works


## Checkout/Order Creation Fix
- [x] Fix coupon normalization to be identical between validateCoupon and checkout.create
- [x] Add coupon code normalization (trim + uppercase) in validateAndApplyCoupon
- [x] Fix CartPage to normalize coupon code before sending to server
- [x] Improve error handling to show real error messages instead of generic "Failed to create order"
- [x] Fix pointsToRedeem payload handling and normalization
- [x] Verify dev server running without errors


## Order Creation orderId Fix
- [x] Fix createOrder to return the inserted order with its ID
- [x] Fix createOrderFromCart to use the correct orderId from the inserted order
- [x] Ensure orderItems are inserted with the correct orderId (not default)
- [x] Verify dev server running without errors


## Drizzle insertId Extraction Fix
- [x] Debug Drizzle MySQL insert result structure
- [x] Fix createOrder to extract insertId from result[0].insertId
- [x] Verify dev server running without errors


## Order ID Retrieval Bug Fix
- [x] Fix createOrder to return { id: insertedId } instead of fetching
- [x] Ensure orderService can access result.id correctly
- [x] Verify orderItems are created with correct orderId
- [x] Dev server running without errors


## Payment Page Blank Screen Fix
- [x] Audit App.tsx route and PaymentPage param handling
- [x] Verify backend query returns complete payment page data
- [x] Fix PaymentPage rendering guards and state handling
- [x] Add loading, error, and empty states to PaymentPage
- [x] Test payment page with different order statuses (vitest: 10/10 passing)
- [x] Fix CartPage to use correct field name (order.id instead of order.orderId)
- [x] Fix PaymentPage orderId parsing to handle NaN safely
- [x] Add missing translations for payment.orderNotFound and nav.viewOrders (Thai + English)
- [x] Verify dev server running without errors


## Payment Record Creation Fix
- [x] Identify root cause: payment record not created when order is created
- [x] Add db.createPayment(orderId) call in createOrderFromCart
- [x] Ensure checkout returns full order object with all fields
- [x] Remove debug logging from PaymentPage and CartPage
- [x] Verify payment page tests pass (10/10 passing)
- [x] Verify dev server running without errors


## Payment Slip Upload Completion Flow Fix
- [x] Fix upload mutation to clear loading state on success (setIsUploading(false))
- [x] Fix upload mutation to clear loading state on error
- [x] Redirect to /orders page immediately after successful slip upload (no setTimeout)
- [x] Update review time text from "within 24 hours" to "1-2 hours" (Thai + English)
- [x] Add missing translation key payment.helpTitle (Thai + English)
- [x] Verify payment page tests pass (10/10 passing)
- [x] Verify dev server running without errors
