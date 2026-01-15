# bun-query-builder TODO

## DynamoDB Driver

### Add DynamoDB Driver
**Status:** Not Started
**Description:** bun-query-builder needs a new DynamoDB driver to support the DynamoDB ORM that transforms Stacks models to single table designs.

**Tasks:**
- [ ] Design DynamoDB driver interface
- [ ] Implement DynamoDB query building
- [ ] Support single table design patterns
- [ ] Integrate with dynamodb-tooling ORM driver
- [ ] Add tests for DynamoDB operations

---

## Notes

- DynamoDB uses single table design patterns
- Should work with Stacks models transformed by dynamodb-tooling
- Perfect use case for pantry registry API backend
