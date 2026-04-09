# GiTrip

A Git-inspired collaborative trip planner built with Node.js, Express, EJS, and SQLite.

## Disclaimer

**This application requires external API keys to be fully functional.** For security reasons, API keys are not included in this repository. You must obtain your own keys from the services listed below. Without these keys, features such as route calculation, place search, and travel news will not work.

## Prerequisites

- **Node.js** v18 or later
- **npm** (included with Node.js)

## Setup

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd gitrip
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment variables**

   Copy the example environment file and fill in your own API keys:

   ```bash
   cp .env.example .env
   ```

   Then edit `.env` and replace the placeholder values:

   | Variable | Description | Where to obtain |
   |---|---|---|
   | `PORT` | Server port (default `4000`) | -- |
   | `SESSION_SECRET` | Session secret; generate with `openssl rand -hex 32` | -- |
   | `DATABASE_URL` | SQLite database path (default `file:./data/gitrip.sqlite`) | -- |
   | `ORS_API_KEY` | OpenRouteService API key for route calculations | [openrouteservice.org](https://openrouteservice.org/dev/#/signup) |
   | `GOOGLE_DIRECTIONS_API_KEY` | Google Directions API key for driving/transit directions | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) |
   | `NOMINATIM_EMAIL` | Your email (required by Nominatim usage policy for geocoding) | Use your own email |
   | `NEWS_API_KEY` | GNews API key for travel-related news | [gnews.io](https://gnews.io/) |
   | `BASE_URL` | Base URL of the app (default `http://localhost:4000`) | -- |
   | `CORS_ORIGIN` | Allowed CORS origin (default `http://localhost:4000`) | -- |

4. **Start the server**

   ```bash
   # Production
   npm start

   # Development (same command; watches are not configured)
   npm run dev
   ```

   The app will be available at [http://localhost:4000](http://localhost:4000).

## Running Tests

```bash
npm test
```

This runs all test files in the `test/` directory using the Node.js built-in test runner.

## CLI

GiTrip also includes a command-line interface:

```bash
npm run gitrip -- <command>
```

## Project Structure

```
gitrip/
  server/         # Express app, routes, models, views (EJS)
  cli/            # CLI tool
  test/           # Test suite
  .env.example    # Environment variable template
  package.json
```

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express
- **Templating**: EJS
- **Database**: SQLite (via better-sqlite3)
- **Styling**: Custom CSS
