# Auth

Reminder-batch and most CRM routes additionally require `x-user-type: CRM` (or
`userType: "CRM"` in the JWT payload) on top of the platform-standard gateway-header/
Bearer-JWT auth. A plain authenticated portal user gets 403'd from those endpoints
regardless of policy permissions — a passing `requirePermission()` check alone is not
sufficient to reach those routes.
