export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-lg tracking-tight font-semibold">YumCut Storage Service</p>
        <p className="text-sm text-slate-300">
          Dedicated storage worker for YumCut media. Visit yumcut.com →{' '}
          <a className="underline text-slate-100" href="https://yumcut.com" target="_blank" rel="noreferrer">
            https://yumcut.com
          </a>
        </p>
      </div>
    </main>
  );
}
