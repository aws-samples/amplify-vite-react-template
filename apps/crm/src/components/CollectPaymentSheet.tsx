import { useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { api, opResult } from "../lib/api";
import { useAction } from "../lib/useAsync";
import { Button, ErrorNote, Sheet, Spinner } from "../ui/kit";

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as
  | string
  | undefined;

/**
 * Collect or update a customer's payment method (card or US bank account)
 * via a Stripe SetupIntent. Card/bank data goes straight to Stripe —
 * nothing sensitive touches our backend. Used by the office (before first
 * treatment) and the customer portal (self-service update).
 */
export default function CollectPaymentSheet({
  customerId,
  open,
  onClose,
  onSaved,
}: {
  customerId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stripePromise = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    []
  );

  useEffect(() => {
    if (!open || !publishableKey) return;
    setClientSecret(null);
    setError(null);
    api()
      .mutations.createSetupIntent({ customerId })
      .then((res) => {
        const data = opResult<{ clientSecret?: string }>(res);
        if (!data?.clientSecret) throw new Error("No client secret returned");
        setClientSecret(data.clientSecret);
      })
      .catch((err) => setError(err.message ?? "Could not start Stripe setup"));
  }, [open, customerId]);

  return (
    <Sheet open={open} onClose={onClose} title="Payment method">
      {!publishableKey ? (
        <ErrorNote error="Stripe publishable key is not configured (VITE_STRIPE_PUBLISHABLE_KEY)." />
      ) : error ? (
        <ErrorNote error={error} />
      ) : !clientSecret || !stripePromise ? (
        <Spinner label="Connecting to Stripe…" />
      ) : (
        <Elements
          stripe={stripePromise}
          options={{ clientSecret, appearance: { variables: { colorPrimary: "#176b2c" } } }}
        >
          <SetupForm onSaved={onSaved} />
        </Elements>
      )}
    </Sheet>
  );
}

function SetupForm({ onSaved }: { onSaved: () => void }) {
  const stripe = useStripe();
  const elements = useElements();

  // A held Enter or a double-click used to beat the `disabled` button and fire
  // a second confirmSetup; the single-flight gate refuses the second call.
  const save = useAction(async () => {
    if (!stripe || !elements) throw new Error("Stripe is still loading");
    const result = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
    });
    // Stripe reports failure in the payload rather than by throwing — rethrow
    // so the gate and the captured error see it like any other failure.
    if (result.error) {
      throw new Error(result.error.message ?? "Could not save payment method");
    }
  }, "Could not save payment method");

  const submit = async () => {
    if (await save.run()) onSaved();
  };

  return (
    <div className="form-grid">
      <PaymentElement />
      <ErrorNote error={save.error} />
      <Button block loading={save.busy} onClick={() => void submit()}>
        Save payment method
      </Button>
      <p className="muted small">
        Stored securely with Stripe. BuzzKill never sees your card or account
        number.
      </p>
    </div>
  );
}
