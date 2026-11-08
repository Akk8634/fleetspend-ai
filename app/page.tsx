export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-center py-32 px-16 bg-white">
        <h1 className="text-3xl font-semibold tracking-tight text-black">
          FleetSpend AI
        </h1>
        <p className="mt-4 text-lg text-zinc-600">
          AI-powered invoice processing and fleet spend management.
        </p>
      </main>
    </div>
  );
}
