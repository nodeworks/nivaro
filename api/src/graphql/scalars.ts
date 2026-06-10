import { GraphQLScalarType, Kind, type ValueNode } from 'graphql'

function parseLiteral(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value
    case Kind.INT:
      return parseInt(ast.value, 10)
    case Kind.FLOAT:
      return parseFloat(ast.value)
    case Kind.LIST:
      return ast.values.map(parseLiteral)
    case Kind.OBJECT: {
      const obj: Record<string, unknown> = {}
      for (const f of ast.fields) obj[f.name.value] = parseLiteral(f.value)
      return obj
    }
    case Kind.NULL:
      return null
    default:
      return null
  }
}

export const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON value — objects, arrays, strings, numbers, booleans, or null.',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral
})

export const GraphQLDateTime = new GraphQLScalarType({
  name: 'DateTime',
  description: 'ISO 8601 date-time string.',
  serialize: (v) => (v instanceof Date ? v.toISOString() : v != null ? String(v) : null),
  parseValue: (v) => (v ? new Date(v as string) : null),
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? new Date(ast.value) : null)
})
