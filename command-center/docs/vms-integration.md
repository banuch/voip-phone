# External CCTV / VMS integration (optional)

Video is out of scope: no streaming, recording, storage, analytics or video
walls. The platform only provides **context** for the customer's own VMS.

| Capability | How |
|------------|-----|
| Camera mapping | `atm_devices.vms_camera_ref` (free text: camera id, channel, NVR path) |
| Deep link | `atm_devices.vms_deep_link`, a URL template with `{atmCode}` and `{cameraRef}` placeholders, e.g. `https://vms.bank.internal/live?camera={cameraRef}`. Shown only to users with `vms:link`, opened in a new tab with `noopener`. |
| Default template | system setting `vms.defaultDeepLinkTemplate` |
| Incident correlation | `POST /api/v1/queue` accepts `externalRef` (VMS incident id); it is stored on the request and audited, so an incident raised in the VMS can become a prioritised call request that an operator places |
| SDK adapters | add a module implementing the same pattern as the SIP driver: a narrow interface, the vendor SDK behind it, enabled per organization |

Integrations never receive SIP credentials or call control; they can only
raise requests that a human operator acts on.
