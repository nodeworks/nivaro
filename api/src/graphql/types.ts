import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString
} from 'graphql'
import { GraphQLDateTime, GraphQLJSON } from './scalars.js'

export { GraphQLDateTime, GraphQLJSON } from './scalars.js'

// ── System types ───────────────────────────────────────────────────────────────

export const RoleType = new GraphQLObjectType({
  name: 'Role',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    adminAccess: { type: new GraphQLNonNull(GraphQLBoolean) },
    appAccess: { type: new GraphQLNonNull(GraphQLBoolean) }
  }
})

export const UserType: GraphQLObjectType = new GraphQLObjectType({
  name: 'User',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    firstName: { type: GraphQLString },
    lastName: { type: GraphQLString },
    role: { type: GraphQLString },
    status: { type: GraphQLString },
    lastAccess: { type: GraphQLDateTime },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime }
  }
})

export const MeType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Me',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    email: { type: new GraphQLNonNull(GraphQLString) },
    firstName: { type: GraphQLString },
    lastName: { type: GraphQLString },
    role: { type: GraphQLString },
    isAdmin: { type: new GraphQLNonNull(GraphQLBoolean) },
    status: { type: GraphQLString }
  }
})

// ── Workflow types ─────────────────────────────────────────────────────────────

export const WorkflowStateType: GraphQLObjectType = new GraphQLObjectType({
  name: 'WorkflowState',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    key: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    color: { type: GraphQLString },
    isInitial: { type: new GraphQLNonNull(GraphQLBoolean) },
    isTerminal: { type: new GraphQLNonNull(GraphQLBoolean) },
    lockRecord: { type: new GraphQLNonNull(GraphQLBoolean) },
    sort: { type: new GraphQLNonNull(GraphQLInt) },
    skipCriteria: { type: GraphQLJSON }
  }
})

export const WorkflowTransitionType: GraphQLObjectType = new GraphQLObjectType({
  name: 'WorkflowTransition',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    fromState: { type: GraphQLID },
    toState: { type: new GraphQLNonNull(GraphQLID) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    color: { type: GraphQLString },
    requiredRoles: { type: new GraphQLList(new GraphQLNonNull(GraphQLID)) },
    actions: { type: GraphQLJSON },
    sort: { type: new GraphQLNonNull(GraphQLInt) }
  }
})

export const WorkflowBindingType: GraphQLObjectType = new GraphQLObjectType({
  name: 'WorkflowBinding',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    stateField: { type: GraphQLString }
  }
})

export const WorkflowHistoryEntryType: GraphQLObjectType = new GraphQLObjectType({
  name: 'WorkflowHistoryEntry',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    transition: { type: GraphQLID },
    fromState: { type: WorkflowStateType },
    toState: { type: new GraphQLNonNull(WorkflowStateType) },
    user: { type: UserType },
    comment: { type: GraphQLString },
    timestamp: { type: new GraphQLNonNull(GraphQLDateTime) }
  })
})

export const WorkflowInstanceType: GraphQLObjectType = new GraphQLObjectType({
  name: 'WorkflowInstance',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    item: { type: new GraphQLNonNull(GraphQLID) },
    currentState: { type: WorkflowStateType },
    startedAt: { type: new GraphQLNonNull(GraphQLDateTime) },
    completedAt: { type: GraphQLDateTime },
    history: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowHistoryEntryType)))
    },
    availableTransitions: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowTransitionType)))
    }
  })
})

export const WorkflowTemplateType: GraphQLObjectType = new GraphQLObjectType({
  name: 'WorkflowTemplate',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    color: { type: GraphQLString },
    icon: { type: GraphQLString },
    states: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowStateType)))
    },
    transitions: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowTransitionType)))
    },
    bindings: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowBindingType)))
    },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime }
  })
})

export const WorkflowTransitionResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'WorkflowTransitionResult',
  fields: () => ({
    instance: { type: new GraphQLNonNull(WorkflowInstanceType) },
    newState: { type: new GraphQLNonNull(WorkflowStateType) }
  })
})

// ── Pipeline types ─────────────────────────────────────────────────────────────

export const PipelineDimensionType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineDimension',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    field: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    sort: { type: new GraphQLNonNull(GraphQLInt) },
    isRowAxis: { type: new GraphQLNonNull(GraphQLBoolean) },
    required: { type: new GraphQLNonNull(GraphQLBoolean) }
  }
})

export const PipelineOwnerGroupType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineOwnerGroup',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: GraphQLString },
    filters: { type: GraphQLJSON },
    isDefault: { type: new GraphQLNonNull(GraphQLBoolean) },
    sort: { type: new GraphQLNonNull(GraphQLInt) },
    priority: { type: new GraphQLNonNull(GraphQLInt) },
    users: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserType))) }
  })
})

export const PipelineBindingType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineBinding',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    stateField: { type: GraphQLString },
    dimensions: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PipelineDimensionType)))
    }
  })
})

export const PipelineStateType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineState',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    key: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    color: { type: GraphQLString },
    isInitial: { type: new GraphQLNonNull(GraphQLBoolean) },
    isTerminal: { type: new GraphQLNonNull(GraphQLBoolean) },
    lockRecord: { type: new GraphQLNonNull(GraphQLBoolean) },
    sort: { type: new GraphQLNonNull(GraphQLInt) },
    skipCriteria: { type: GraphQLJSON },
    ownerGroups: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PipelineOwnerGroupType)))
    }
  })
})

export const PipelineTemplateType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineTemplate',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    color: { type: GraphQLString },
    icon: { type: GraphQLString },
    states: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PipelineStateType)))
    },
    bindings: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PipelineBindingType)))
    },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime }
  })
})

export const StateOwnersType: GraphQLObjectType = new GraphQLObjectType({
  name: 'StateOwners',
  fields: () => ({
    state: { type: new GraphQLNonNull(WorkflowStateType) },
    owners: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(UserType))) }
  })
})

export const PipelineOwnersResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineOwnersResult',
  fields: () => ({
    byState: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(StateOwnersType)))
    }
  })
})

export const PipelineMatrixType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineMatrix',
  fields: () => ({
    template: { type: new GraphQLNonNull(PipelineTemplateType) },
    states: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(PipelineStateType)))
    },
    matrix: { type: new GraphQLNonNull(GraphQLJSON) }
  })
})

export const PipelineInstanceType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineInstance',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    item: { type: new GraphQLNonNull(GraphQLID) },
    currentState: { type: PipelineStateType },
    startedAt: { type: new GraphQLNonNull(GraphQLDateTime) },
    completedAt: { type: GraphQLDateTime },
    history: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowHistoryEntryType)))
    },
    availableTransitions: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(WorkflowTransitionType)))
    }
  })
})

// ── Activity / Files / Settings ────────────────────────────────────────────────

export const ActivityEntryType: GraphQLObjectType = new GraphQLObjectType({
  name: 'ActivityEntry',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    action: { type: new GraphQLNonNull(GraphQLString) },
    collection: { type: GraphQLString },
    item: { type: GraphQLString },
    user: { type: UserType },
    userAgent: { type: GraphQLString },
    ip: { type: GraphQLString },
    comment: { type: GraphQLString },
    timestamp: { type: new GraphQLNonNull(GraphQLDateTime) }
  })
})

export const CmsFileType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CmsFile',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    filenameDownload: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: GraphQLString },
    type: { type: GraphQLString },
    filesize: { type: GraphQLInt },
    folder: { type: GraphQLID },
    uploadedBy: { type: UserType },
    uploadedOn: { type: GraphQLDateTime }
  })
})

export const SettingsType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Settings',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLInt) },
    projectName: { type: GraphQLString },
    projectColor: { type: GraphQLString },
    projectLogo: { type: GraphQLString },
    publicForeground: { type: GraphQLString },
    publicBackground: { type: GraphQLString },
    defaultLanguage: { type: GraphQLString },
    darkMode: { type: GraphQLBoolean }
  }
})

// ── Subscription event types ───────────────────────────────────────────────────

export const WorkflowStateChangedEventType: GraphQLObjectType = new GraphQLObjectType({
  name: 'WorkflowStateChangedEvent',
  fields: () => ({
    collection: { type: new GraphQLNonNull(GraphQLString) },
    item: { type: new GraphQLNonNull(GraphQLID) },
    instance: { type: new GraphQLNonNull(WorkflowInstanceType) }
  })
})

export const PipelineStateChangedEventType: GraphQLObjectType = new GraphQLObjectType({
  name: 'PipelineStateChangedEvent',
  fields: () => ({
    collection: { type: new GraphQLNonNull(GraphQLString) },
    item: { type: new GraphQLNonNull(GraphQLID) },
    instance: { type: new GraphQLNonNull(PipelineInstanceType) }
  })
})

export const ItemMutatedEventType: GraphQLObjectType = new GraphQLObjectType({
  name: 'ItemMutatedEvent',
  fields: {
    collection: { type: new GraphQLNonNull(GraphQLString) },
    item: { type: new GraphQLNonNull(GraphQLID) },
    action: { type: new GraphQLNonNull(GraphQLString) },
    data: { type: GraphQLJSON }
  }
})

export const ALL_DOMAIN_TYPES = [
  RoleType,
  UserType,
  MeType,
  WorkflowStateType,
  WorkflowTransitionType,
  WorkflowBindingType,
  WorkflowHistoryEntryType,
  WorkflowInstanceType,
  WorkflowTemplateType,
  WorkflowTransitionResultType,
  PipelineDimensionType,
  PipelineOwnerGroupType,
  PipelineBindingType,
  PipelineStateType,
  PipelineTemplateType,
  StateOwnersType,
  PipelineOwnersResultType,
  PipelineMatrixType,
  PipelineInstanceType,
  ActivityEntryType,
  CmsFileType,
  SettingsType,
  WorkflowStateChangedEventType,
  PipelineStateChangedEventType,
  ItemMutatedEventType
]
