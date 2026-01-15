# bun-query-builder TODO

## DynamoDB Driver

### Add DynamoDB Driver
**Status:** Complete
**Description:** bun-query-builder needs a new DynamoDB driver to support the DynamoDB ORM that transforms Stacks models to single table designs.

**Tasks:**
- [x] Design DynamoDB driver interface
- [x] Implement DynamoDB query building
- [x] Support single table design patterns
- [x] Integrate with dynamodb-tooling ORM driver
- [x] Add tests for DynamoDB operations

---

## Notes

- DynamoDB uses single table design patterns
- Should work with Stacks models transformed by dynamodb-tooling
- Perfect use case for pantry registry API backend
