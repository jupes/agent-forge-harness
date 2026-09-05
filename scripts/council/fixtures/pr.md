# PR fixture: tenant invoice lookup

Acceptance criteria: an authenticated user can read only invoices belonging to their own tenant. Cross-tenant invoice IDs must return 404. Existing public health checks must remain unchanged.

```diff
diff --git a/src/invoices.ts b/src/invoices.ts
@@ -12,3 +12,4 @@
 router.get('/invoices/:id', requireLogin, async (req, res) => {
-  const invoice = await db.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
+  const invoice = await db.invoice.findFirst({ where: { id: req.params.id } });
+  if (!invoice) return res.status(404).end();
   return res.json(invoice);
 });
```

The added test checks a logged-in user's own invoice. No cross-tenant test is supplied. The health-check code is unchanged. Do not invent a health-check regression.
