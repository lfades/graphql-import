import { keyBy, uniqBy, includes } from 'lodash'
import {
  DocumentNode,
  TypeDefinitionNode,
  ObjectTypeDefinitionNode,
  InputObjectTypeDefinitionNode,
  TypeNode,
  NamedTypeNode,
  DirectiveNode,
  DirectiveDefinitionNode,
  InputValueDefinitionNode,
  FieldDefinitionNode,
  SchemaDefinitionNode
} from 'graphql'

const builtinTypes = ['String', 'Float', 'Int', 'Boolean', 'ID']

const builtinDirectives = ['deprecated', 'skip','include']

export type ValidDefinitionNode =
    | DirectiveDefinitionNode
    | TypeDefinitionNode
    | SchemaDefinitionNode

export interface DefinitionMap {
  [key: string]: ValidDefinitionNode
}

/**
 * Post processing of all imported type definitions. Loops over each of the
 * imported type definitions, and processes it using collectNewTypeDefinitions.
 *
 * @param allDefinitions All definitions from all schemas
 * @param definitionPool Current definitions (from first schema)
 * @param newTypeDefinitions All imported definitions
 * @returns Final collection of type definitions for the resulting schema
 */
export function completeDefinitionPool(
  allDefinitions: ValidDefinitionNode[],
  definitionPool: ValidDefinitionNode[],
  newTypeDefinitions: ValidDefinitionNode[],
): ValidDefinitionNode[] {
  const visitedDefinitions: { [name: string]: boolean } = {}
  while (newTypeDefinitions.length > 0) {
    const schemaMap: DefinitionMap = keyBy(allDefinitions, d => getNodeName(d))
    const newDefinition = newTypeDefinitions.shift()
    if (visitedDefinitions[getNodeName(newDefinition)]) {
      continue
    }

    const collectedTypedDefinitions = collectNewTypeDefinitions(
      allDefinitions,
      definitionPool,
      newDefinition,
      schemaMap,
    )
    newTypeDefinitions.push(...collectedTypedDefinitions)
    definitionPool.push(...collectedTypedDefinitions)

    visitedDefinitions[getNodeName(newDefinition)] = true
  }

  return uniqBy(definitionPool, 'name.value')
}

/**
 * Returns the name of a type definition or schema in the case of
 * SchemaDefinition
 * @param node GraphQL type node
 */
export function getNodeName(node: ValidDefinitionNode): string {
  if (node.kind === 'SchemaDefinition') {
    return 'schema'
  }
  return node.name.value
}

/**
 * Processes a single type definition, and performs a number of checks:
 * - Add missing interface implementations
 * - Add missing referenced types
 * - Remove unused type definitions
 *
 * @param allDefinitions All definitions from all schemas
 * (only used to find missing interface implementations)
 * @param definitionPool Resulting definitions
 * @param newDefinition All imported definitions
 * @param schemaMap Map of all definitions for easy lookup
 * @returns All relevant type definitions to add to the final schema
 */
function collectNewTypeDefinitions(
  allDefinitions: ValidDefinitionNode[],
  definitionPool: ValidDefinitionNode[],
  newDefinition: ValidDefinitionNode,
  schemaMap: DefinitionMap,
): ValidDefinitionNode[] {
  let newTypeDefinitions: ValidDefinitionNode[] = []

  if (newDefinition.kind !== 'DirectiveDefinition') {
    newDefinition.directives.forEach(collectDirective)
  }

  if (newDefinition.kind === 'InputObjectTypeDefinition') {
    newDefinition.fields.forEach(collectNode)
  }

  if (newDefinition.kind === 'InterfaceTypeDefinition') {
    const interfaceName = newDefinition.name.value
    newDefinition.fields.forEach(collectNode)

    const interfaceImplementations = allDefinitions.filter(
      d =>
        d.kind === 'ObjectTypeDefinition' &&
        d.interfaces.some(i => i.name.value === interfaceName),
    )
    newTypeDefinitions.push(...interfaceImplementations)
  }

  if (newDefinition.kind === 'UnionTypeDefinition') {
    newDefinition.types.forEach(collectType)
  }

  if (newDefinition.kind === 'ObjectTypeDefinition') {
    // collect missing interfaces
    newDefinition.interfaces.forEach(int => {
      if (!definitionPool.some(d => getNodeName(d) === int.name.value)) {
        const interfaceName = int.name.value
        const interfaceMatch = schemaMap[interfaceName]
        if (!interfaceMatch) {
          throw new Error(
            `Couldn't find interface ${interfaceName} in any of the schemas.`,
          )
        }
        newTypeDefinitions.push(schemaMap[int.name.value])
      }
    })

    // iterate over all fields
    newDefinition.fields.forEach(field => {
      collectNode(field)
      // collect missing argument input types
      field.arguments.forEach(collectNode)
    })
  }

  if (newDefinition.kind === 'SchemaDefinition') {
    // Include types when a name other than Query/Mutation/Subscription is used
    newDefinition.operationTypes.forEach(node => collectType(node.type))
  }

  return newTypeDefinitions

  function collectNode(node: FieldDefinitionNode | InputValueDefinitionNode) {
    const nodeType = getNamedType(node.type)
    const nodeTypeName = nodeType.name.value

    // collect missing argument input types
    if (
      !definitionPool.some(d => getNodeName(d) === nodeTypeName) &&
      !includes(builtinTypes, nodeTypeName)
    ) {
      const argTypeMatch = schemaMap[nodeTypeName]
      if (!argTypeMatch) {
        throw new Error(
          `Field ${node.name.value}: Couldn't find type ${nodeTypeName} in any of the schemas.`,
        )
      }
      newTypeDefinitions.push(argTypeMatch)
    }

    node.directives.forEach(collectDirective)
  }

  function collectDirective(directive: DirectiveNode) {
    const directiveName = directive.name.value
    if (
      !definitionPool.some(d => getNodeName(d) === directiveName) &&
      !includes(builtinDirectives, directiveName)
    ) {
      const directive = schemaMap[directiveName] as DirectiveDefinitionNode
      if (!directive) {
        throw new Error(
          `Directive ${directiveName}: Couldn't find type ${
            directiveName
          } in any of the schemas.`,
        )
      }
      directive.arguments.forEach(collectNode)

      newTypeDefinitions.push(directive)
    }
  }

  function collectType(type: NamedTypeNode) {
    if (!definitionPool.some(d => getNodeName(d) === type.name.value)) {
      const typeName = type.name.value
      const typeMatch = schemaMap[typeName]
      if (!typeMatch) {
        throw new Error(`Couldn't find type ${typeName} in any of the schemas.`)
      }
      newTypeDefinitions.push(schemaMap[typeName])
    }
  }
}

/**
 * Nested visitor for a type node to get to the final NamedType
 *
 * @param {TypeNode} type Type node to get NamedTypeNode for
 * @returns {NamedTypeNode} The found NamedTypeNode
 */
function getNamedType(type: TypeNode): NamedTypeNode {
  if (type.kind === 'NamedType') {
    return type
  } else {
    return getNamedType(type.type)
  }
}
