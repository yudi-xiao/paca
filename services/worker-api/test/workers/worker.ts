export { DocumentParty } from "../../src/document/party";
export { ProjectParty, UserParty } from "../../src/realtime/party";

export default {
  fetch(): Response {
    return Response.json({ status: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
