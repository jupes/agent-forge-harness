## Migration Patterns

### `value as Type` -> `fromPartial(value)`

Use `fromPartial()` when the test supplies a subset of a larger type and the supplied properties should still type-check.

Before:

```ts
getUser({ body: { id: "123" } } as Request);
```

After:

```ts
import { fromPartial } from "@total-typescript/shoehorn";

getUser(fromPartial({ body: { id: "123" } }));
```

If TypeScript cannot infer the target from context, provide the target type explicitly:

```ts
const request = fromPartial<Request>({
  body: { id: "123" },
});
```

### `value as unknown as Type` -> `fromAny(value)`

Use `fromAny()` only when the test intentionally passes invalid data, such as exercising validation or error handling paths. This replaces double assertions while keeping the intent visible.

Before:

```ts
getUser({ body: { id: 123 } } as unknown as Request);
```

After:

```ts
import { fromAny } from "@total-typescript/shoehorn";

getUser(fromAny({ body: { id: 123 } }));
```

### Full-Shape Fixtures -> `fromExact(value)`

Use `fromExact()` as a temporary helper when a fixture already has the full shape and you want to keep the migration mechanical before deciding whether it can be reduced.

```ts
import { fromExact } from "@total-typescript/shoehorn";

const request = fromExact<Request>({
  body: { id: "123" },
  headers: {},
  cookies: {},
});
```

Prefer `fromPartial()` once the test only needs a subset of the object. `fromExact()` should not become a dumping ground for unnecessary fixture fields.
