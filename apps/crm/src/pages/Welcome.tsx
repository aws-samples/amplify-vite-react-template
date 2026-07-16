import { useEffect, useRef, useState } from "react";
import {
  confirmSignIn,
  getCurrentUser,
  signIn,
} from "aws-amplify/auth";
import { Button, EmptyState, Spinner } from "../ui/kit";

/**
 * Magic-link landing page. The emailed link is
 * /welcome#email=<email>&token=<single-use token> — the token stays in the
 * URL fragment so it never reaches server logs. Redeeming it completes the
 * Cognito custom-auth flow and drops the user into the app, signed in.
 */
export default function Welcome() {
  const [state, setState] = useState<"working" | "error">("working");
  const [message, setMessage] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // React strict-mode double-mount guard
    ran.current = true;

    (async () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const email = params.get("email");
      const token = params.get("token");
      if (!email || !token) {
        setMessage("This sign-in link is incomplete — request a new one from the login page.");
        setState("error");
        return;
      }

      try {
        await getCurrentUser();
        // Already signed in on this device — just go home.
        window.location.replace("/");
        return;
      } catch {
        /* not signed in — redeem the link */
      }

      try {
        const { nextStep } = await signIn({
          username: email,
          options: { authFlowType: "CUSTOM_WITHOUT_SRP" },
        });
        if (nextStep.signInStep !== "CONFIRM_SIGN_IN_WITH_CUSTOM_CHALLENGE") {
          throw new Error("Unexpected sign-in step");
        }
        const { isSignedIn } = await confirmSignIn({
          challengeResponse: token,
        });
        if (!isSignedIn) throw new Error("Sign-in was not completed");
        window.location.replace("/");
      } catch {
        setMessage(
          "This link has expired or was already used. Request a fresh one with “Email me a sign-in link” on the login page."
        );
        setState("error");
      }
    })();
  }, []);

  if (state === "working") {
    return (
      <div className="auth-shell">
        <Spinner label="Signing you in…" />
      </div>
    );
  }
  return (
    <div className="auth-shell">
      <EmptyState
        title="Couldn't sign you in"
        body={message ?? undefined}
        action={
          <Button onClick={() => window.location.replace("/")}>
            Go to login
          </Button>
        }
      />
    </div>
  );
}
