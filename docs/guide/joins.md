# Joins

Learn how to join multiple tables in your queries.

## Basic Joins

### Inner Join

Returns only matching rows from both tables:

```typescript
const postsWithUsers = await db
  .selectFrom('posts')
  .join('users', 'posts.user_id', '=', 'users.id')
  .select(['posts.*', 'users.name as author_name'])
  .get()
```

### Left Join

Returns all rows from the left table, with matching rows from the right:

```typescript
const usersWithPosts = await db
  .selectFrom('users')
  .leftJoin('posts', 'users.id', '=', 'posts.user_id')
  .select(['users.*', 'posts.title'])
  .get()
```

### Right Join

Returns all rows from the right table, with matching rows from the left:

```typescript
const postsWithOptionalUsers = await db
  .selectFrom('posts')
  .rightJoin('users', 'posts.user_id', '=', 'users.id')
  .select(['users.*', 'posts.title'])
  .get()
```

### Cross Join

Returns the Cartesian product of both tables:

```typescript
const combinations = await db
  .selectFrom('colors')
  .crossJoin('sizes')
  .get()
```

## Advanced Join Conditions

### Multiple Join Conditions

```typescript
const result = await db
  .selectFrom('orders')
  .join('order_items', (join) => {
    join
      .on('orders.id', '=', 'order_items.order_id')
      .on('order_items.status', '=', 'active')
  })
  .get()
```

### Join with OR Conditions

```typescript
const result = await db
  .selectFrom('users')
  .join('accounts', (join) => {
    join
      .on('users.id', '=', 'accounts.user_id')
      .orOn('users.email', '=', 'accounts.email')
  })
  .get()
```

## Multiple Joins

```typescript
const orders = await db
  .selectFrom('orders')
  .join('users', 'orders.user_id', '=', 'users.id')
  .join('products', 'orders.product_id', '=', 'products.id')
  .join('categories', 'products.category_id', '=', 'categories.id')
  .select([
    'orders.id',
    'users.name as customer',
    'products.name as product',
    'categories.name as category',
    'orders.total'
  ])
  .get()
```

## Self Joins

Join a table to itself:

```typescript
// Get employees with their managers
const employees = await db
  .selectFrom('employees as e')
  .leftJoin('employees as m', 'e.manager_id', '=', 'm.id')
  .select([
    'e.name as employee',
    'm.name as manager'
  ])
  .get()
```

## Subquery Joins

```typescript
const topSellers = await db
  .selectFrom('users')
  .join(
    (subquery) => {
      subquery
        .selectFrom('orders')
        .select(['user_id', 'SUM(total) as total_sales'])
        .groupBy('user_id')
        .having('total_sales', '>', 1000)
    },
    'sales',
    'users.id',
    '=',
    'sales.user_id'
  )
  .get()
```

## Join with Aggregates

```typescript
// Get users with their post count
const usersWithPostCount = await db
  .selectFrom('users')
  .leftJoin('posts', 'users.id', '=', 'posts.user_id')
  .select(['users.*', 'COUNT(posts.id) as post_count'])
  .groupBy('users.id')
  .get()
```

## Examples

### E-commerce Order Details

```typescript
async function getOrderDetails(orderId: number) {
  return db
    .selectFrom('orders')
    .join('users', 'orders.user_id', '=', 'users.id')
    .join('order_items', 'orders.id', '=', 'order_items.order_id')
    .join('products', 'order_items.product_id', '=', 'products.id')
    .leftJoin('coupons', 'orders.coupon_id', '=', 'coupons.id')
    .where('orders.id', '=', orderId)
    .select([
      'orders.id',
      'orders.status',
      'orders.total',
      'users.name as customer_name',
      'users.email as customer_email',
      'products.name as product_name',
      'order_items.quantity',
      'order_items.price',
      'coupons.code as coupon_code'
    ])
    .get()
}
```

### Blog Posts with Authors and Comments

```typescript
async function getPostsWithDetails() {
  return db
    .selectFrom('posts')
    .join('users', 'posts.user_id', '=', 'users.id')
    .leftJoin('comments', 'posts.id', '=', 'comments.post_id')
    .leftJoin('categories', 'posts.category_id', '=', 'categories.id')
    .select([
      'posts.id',
      'posts.title',
      'posts.body',
      'users.name as author',
      'categories.name as category',
      'COUNT(comments.id) as comment_count'
    ])
    .groupBy(['posts.id', 'users.name', 'categories.name'])
    .orderByDesc('posts.created_at')
    .get()
}
```

### Hierarchical Data

```typescript
// Categories with parent/child relationship
async function getCategoriesWithParent() {
  return db
    .selectFrom('categories as c')
    .leftJoin('categories as p', 'c.parent_id', '=', 'p.id')
    .select([
      'c.id',
      'c.name',
      'p.name as parent_name'
    ])
    .orderBy('c.name')
    .get()
}
```

### User Permissions

```typescript
async function getUserPermissions(userId: number) {
  return db
    .selectFrom('users')
    .join('user_roles', 'users.id', '=', 'user_roles.user_id')
    .join('roles', 'user_roles.role_id', '=', 'roles.id')
    .join('role_permissions', 'roles.id', '=', 'role_permissions.role_id')
    .join('permissions', 'role_permissions.permission_id', '=', 'permissions.id')
    .where('users.id', '=', userId)
    .select(['permissions.name'])
    .distinct()
    .get()
}
```

## Performance Tips

1. **Index Join Columns**: Ensure columns used in join conditions are indexed
2. **Select Only Needed Columns**: Avoid `SELECT *` with multiple joins
3. **Use Appropriate Join Types**: Use `INNER JOIN` when you need matching rows only
4. **Limit Results**: Apply filters and limits to reduce the result set
5. **Consider Query Caching**: Cache frequently used join queries

## Next Steps

- Learn about [insert, update, delete](./insert-update-delete.md)
- Explore [transactions](./transactions.md)
- Go back to [select queries](./select.md)
