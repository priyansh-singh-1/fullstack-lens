# FullStack Lens

FullStack Lens is a VS Code extension that helps developers understand and navigate the connection between frontend API calls and backend endpoints in full-stack applications.

Instead of manually searching through frontend and backend code, FullStack Lens scans the workspace, identifies API relationships, and allows developers to navigate directly between connected parts of the application.

## Current Features

### REST API Analysis

FullStack Lens can detect Spring Boot REST endpoints such as:

```java
@GetMapping("/history")
@PostMapping("/login")
@PutMapping("/user")
@DeleteMapping("/message")
```

It also detects frontend HTTP calls made using Axios and custom Axios instances.

Example:

```javascript
API.post("/auth/login", form);
```

FullStack Lens resolves the complete route and matches it with the corresponding Spring Boot endpoint.

### Frontend → Backend Navigation

Place the cursor on a frontend API call and run:

`FullStack Lens: Go to Backend`

The extension opens the corresponding Spring Boot controller and highlights the matched endpoint.

### Backend → Frontend Navigation

From a Spring Boot REST endpoint, run:

`FullStack Lens: Find Frontend Usages`

FullStack Lens finds frontend files that use the endpoint.

If multiple usages exist, they are displayed in a selection menu.

### WebSocket / STOMP Support

FullStack Lens can detect Spring WebSocket endpoints using:

```java
@MessageMapping("/chat.send")
```

It resolves application destination prefixes such as:

```java
registry.setApplicationDestinationPrefixes("/app");
```

to produce:

```text
/app/chat.send
```

The extension also detects frontend STOMP publish and subscribe calls.

Example:

```javascript
stompClient.publish({
    destination: "/app/chat.send",
    body: JSON.stringify(message)
});
```

### WebSocket Frontend → Backend Navigation

WebSocket publish destinations are matched with their corresponding Spring `@MessageMapping` endpoints.

For example:

```text
Frontend
PUBLISH /app/chat.send

        ↓ FullStack Lens

Backend
@MessageMapping("/chat.send")
```

`Go to Backend` works for both REST API calls and WebSocket publish calls.

## How It Works

```text
Workspace
   │
   ├── Frontend
   │     ├── REST API Scanner
   │     └── WebSocket Scanner
   │
   ├── Backend
   │     ├── Spring REST Scanner
   │     └── Spring WebSocket Scanner
   │
   └── Matching Engine
          │
          ├── REST Endpoint Matching
          └── WebSocket Destination Matching
```

## Currently Supported

**Backend**
- Spring Boot REST APIs
- Spring WebSocket / STOMP

**Frontend**
- JavaScript
- TypeScript
- Axios
- Custom Axios instances
- Fetch
- STOMP publish
- STOMP subscribe

## Project Status

🚧 FullStack Lens is currently under active development.

The project is being developed incrementally, with new framework support, navigation capabilities, diagnostics, and developer tooling planned for future releases.

## Planned Features

- WebSocket backend → frontend navigation
- CodeLens integration
- Better unmatched endpoint diagnostics
- Endpoint usage visualization
- Additional frontend frameworks and HTTP clients
- Additional backend framework support
- Improved parsing and static analysis
- Large-project performance improvements

## Development

Install dependencies:

```bash
npm install
```

Compile:

```bash
npm run compile
```

Press `F5` in VS Code and select **VS Code Extension Development** to launch the extension in an Extension Development Host.

## Disclaimer

FullStack Lens is under active development. API detection and matching capabilities may change as support for additional patterns and frameworks is added.