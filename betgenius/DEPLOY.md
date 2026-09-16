# SharpAI Deployment

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started)
- Node.js 18+
- Supabase project: `gzuzuqxvfjszlfclhcfz`

## Database Setup

Run the schema against your Supabase project:

```bash
supabase db push --db-url "postgresql://postgres:[PASSWORD]@db.gzuzuqxvfjszlfclhcfz.supabase.co:5432/postgres" < supabase/schema.sql
```

Or paste the contents of `supabase/schema.sql` into the Supabase SQL Editor.

## Edge Functions

### Link project

```bash
supabase link --project-ref gzuzuqxvfjszlfclhcfz
```

### Set secrets

```bash
supabase secrets set THE_ODDS_API_KEY=your_odds_api_key
```

### Deploy all functions

```bash
supabase functions deploy get-player-stats --no-verify-jwt
supabase functions deploy get-props --no-verify-jwt
supabase functions deploy analyze-pick --no-verify-jwt
```

### Test locally

```bash
supabase functions serve
```

Then call:

```bash
curl -X POST http://localhost:54321/functions/v1/analyze-pick \
  -H "Content-Type: application/json" \
  -d '{"playerName":"LeBron James","sport":"basketball","propType":"points","line":24.5,"pickSide":"over"}'
```

## Frontend

### Install dependencies

```bash
npm install
```

### Run dev server

```bash
npm run dev
```

### Build for production

```bash
npm run build
```

The build output is in `dist/`. Deploy to any static hosting (Vercel, Netlify, etc.).

### Environment variables

Create `.env.local`:

```
VITE_SUPABASE_URL=https://gzuzuqxvfjszlfclhcfz.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key
```
