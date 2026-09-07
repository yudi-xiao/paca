# Architecture Diagram

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         MCP Client                              │
│                    (Claude, etc.)                               │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ stdio
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       index.ts (Entry)                          │
│  - Select exactly one authentication mode                     │
│  - PACA_AGENT_CONFIG → constrained Agent Capability server    │
│  - PACA_API_KEY → legacy API/plugin server                    │
│  - Connect to stdio transport                                  │
└────────────────────────┬────────────────────────────────────────┘
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
┌──────────────────────────┐  ┌───────────────────────────────────┐
│ agent-auth/server.ts     │  │ server.ts (legacy compatibility) │
│ - Grant-scoped tools     │  │ - API/plugin tools               │
│ - Host heartbeat         │  │ - cached permission filtering    │
│ - Agent JWT per request  │  │ - X-API-Key                      │
└────────────┬─────────────┘  └────────────────┬──────────────────┘
             │                                 │
             ▼                                 ▼
 Paca Agent Capability API              Existing Paca HTTP API
```

Agent Auth mode is deliberately smaller than the legacy API-key surface. A local Harness only receives tools represented by both its enrolled capability catalogue and requested Grant scopes. The Paca server remains authoritative for active Grant status, exact constraints, delegated user permission intersection, replay protection, and audit. Local checks only fail closed earlier.

The Agent private key stays on its controlled Host. A managed Computer/Sandbox must not receive `PACA_AGENT_CONFIG`; it will use a separate short-lived capability broker. Harness kind and version are scheduling/presence metadata and never add business permissions.

## Legacy Compatibility Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                        server.ts  (async)                       │
│  - Load plugins: GET /api/v1/plugins → import(remoteEntryUrl)  │
│  - Create Server instance                                       │
│  - Register ListToolsRequestSchema handler                     │
│  - Register CallToolRequestSchema handler                      │
└──────────┬──────────────────────────┬───────────────────────────┘
           │                          │
           │ core tools               │ plugin tools
           ▼                          ▼
┌──────────────────────┐   ┌──────────────────────────────────────┐
│  tools/index.ts      │   │  plugin-loader.ts (PluginRegistry)   │
│  getAllTools()        │   │  - getAllTools() → plugin tool defs  │
│  handleToolCall()    │   │  - handleToolCall() → dispatch to    │
└──────┬───────┬───────┘   │    plugin entry.handleToolCall()     │
       │       │           └──────────────────┬───────────────────┘
       │       │                              │
       ▼       ▼                              ▼ HTTP + X-API-Key
  [core tool handlers]           /api/v1/plugins/{pluginId}/…
       │
       ▼
  api/client.ts (PacaAPIClient)
       │
       │ HTTP + X-API-Key
       ▼
  Paca API (/api/v1/…)
```

## Layer Responsibilities

### Entry Layer (`index.ts`)
- **Purpose**: Application bootstrap
- **Responsibilities**:
  - Load environment variables
  - Validate configuration
  - Initialize server (awaits plugin loading)
  - Handle startup errors

### Server Layer (`server.ts`)
- **Purpose**: MCP protocol implementation
- **Responsibilities**:
  - Call `loadPlugins()` to fetch and import plugin MCP modules
  - Create MCP Server instance
  - Register request handlers that merge core + plugin tools
  - Connect to transport

### Plugin Loader (`plugin-loader.ts`)
- **Purpose**: Dynamic plugin MCP module loading
- **Responsibilities**:
  - Fetch enabled plugins from `GET /api/v1/plugins`
  - Filter plugins that declare `manifest.mcp.remoteEntryUrl`
  - Dynamically `import()` each plugin's MCP entry module
  - Validate the default export against the `PluginMCPEntry` contract
  - Build a `PluginRegistry` that owns tool dispatch

### Tools Layer (`tools/`)
- **Purpose**: Core business logic and tool definitions
- **Responsibilities**:
  - Define core tool schemas
  - Implement core tool handlers
  - Route core tool calls
  - Format responses

### API Layer (`api/`)
- **Purpose**: HTTP communication
- **Responsibilities**:
  - Make HTTP requests
  - Handle authentication
  - Convert formats
  - Return typed responses

### Utils Layer (`utils/`)
- **Purpose**: Reusable utilities
- **Responsibilities**:
  - Format conversion (BlockNote ↔ Markdown)
  - Output formatting
  - Helper functions

### Types Layer (`types/`)
- **Purpose**: Type definitions
- **Responsibilities**:
  - Define interfaces
  - Define input/output types
  - Shared across modules

## Data Flow

### Startup: Plugin Loading

```
1. index.ts calls createServer(config)  [async]
   ↓
2. server.ts calls loadPlugins(config)
   ↓
3. plugin-loader.ts fetches GET /api/v1/plugins
   ↓
4. For each plugin with mcp.remoteEntryUrl:
     import(remoteEntryUrl)  →  validate PluginMCPEntry  →  register
   ↓
5. PluginRegistry built (tool name → plugin mapping)
   ↓
6. Server instance created with merged tool list
```

### Tool Call Flow

```
1. MCP Client sends tool call
   ↓
2. stdio transport receives message
   ↓
3. server.ts routes to CallToolRequestSchema handler
   ↓
4. Try PluginRegistry.handleToolCall(name, args, config)
     → if plugin owns tool: dispatch to plugin entry module
     → plugin calls /api/v1/plugins/{pluginId}/…
   ↓ (if not a plugin tool)
5. tools/index.ts routes to domain handler
   ↓
5. Domain handler calls API client
   ↓
6. API client makes HTTP request
   ↓
7. API client receives response
   ↓
8. API client converts format (if needed)
   ↓
9. Domain handler formats output
   ↓
10. tools/index.ts returns response
   ↓
11. server.ts sends response
   ↓
12. stdio transport sends to MCP Client
```

### Format Conversion Flow

#### Reading Data (BlockNote → Markdown)

```
API Response (BlockNote JSON)
    ↓
api/client.ts receives
    ↓
utils/converters.ts.blocknoteToMarkdown()
    ↓
utils/formatters.ts.format*()
    ↓
Markdown text returned to MCP Client
```

#### Writing Data (Markdown → BlockNote)

```
MCP Client sends Markdown
    ↓
tools handler receives
    ↓
utils/converters.ts.markdownToBlocknote()
    ↓
api/client.ts sends BlockNote JSON
    ↓
API stores BlockNote JSON
```

## Module Dependencies

```
index.ts
  └── server.ts
        └── tools/index.ts
              ├── tools/project-tools.ts
              ├── tools/task-tools.ts
              ├── tools/sprint-tools.ts
              ├── tools/document-tools.ts
              ├── api/client.ts
              └── utils/index.ts
                    ├── utils/converters.ts
                    └── utils/formatters.ts

api/client.ts
  └── types/index.ts

tools/*.ts
  ├── types/index.ts
  └── utils/index.ts

utils/*.ts
  └── types/index.ts

types/index.ts
  (no dependencies)
```

## Key Design Principles

1. **Single Responsibility**: Each module has one clear purpose
2. **Dependency Inversion**: Higher layers depend on abstractions
3. **Open/Closed**: Easy to extend, closed to modification
4. **Type Safety**: Full TypeScript coverage
5. **Separation of Concerns**: Clear boundaries between layers
6. **Testability**: Each module can be tested independently

## Extension Points

### Adding a New Domain

1. Define types in `types/index.ts`
2. Add API methods to `api/client.ts`
3. Create `tools/new-domain-tools.ts`
4. Update `tools/index.ts` to register new tools
5. Add formatters to `utils/formatters.ts` (if needed)

### Adding a New Tool to Existing Domain

1. Add tool definition to `tools/[domain]-tools.ts`
2. Add handler to existing switch statement
3. Add API method to `api/client.ts` (if needed)
4. Update routing in `tools/index.ts` (if new prefix)

### Changing Format Conversion

1. Modify `utils/converters.ts`
2. No changes needed in other layers (encapsulation)

### Changing Output Format

1. Modify formatters in `utils/formatters.ts`
2. No changes needed in business logic (separation of concerns)
