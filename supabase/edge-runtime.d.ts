// Minimal runtime surface for local TypeScript checks; not a Deno runtime substitute.
declare const Deno: { env: { get(name:string):string|undefined }; serve(handler:(req:Request)=>Response|Promise<Response>):void };
