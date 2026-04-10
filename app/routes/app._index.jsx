import { useMatches } from "react-router";

/**
 * Reads the `restoredInfo` value that `app.jsx` set on its loader data.
 * This runs after a reinstall within the 30-day retention window and
 * surfaces a friendly "welcome back" banner on the home page.
 */
function useRestoredInfo() {
  const matches = useMatches();
  const appMatch = matches.find((m) => m.id === "routes/app");
  return appMatch?.data?.restoredInfo || null;
}

export default function Index() {
  const restoredInfo = useRestoredInfo();

  return (
    <s-page>
      <ui-title-bar title="Claude Chat Bot" />

      {restoredInfo ? (
        <s-banner status="success" heading="Bon retour !">
          <s-paragraph>
            Nous avons restauré votre configuration et{" "}
            <s-text emphasis="bold">{restoredInfo.conversations}</s-text>{" "}
            conversation{restoredInfo.conversations > 1 ? "s" : ""} qui
            {restoredInfo.conversations > 1 ? " avaient" : " avait"} été
            supprimée{restoredInfo.conversations > 1 ? "s" : ""} il y a{" "}
            <s-text emphasis="bold">{restoredInfo.age}</s-text> jour
            {restoredInfo.age > 1 ? "s" : ""}. Vos données sont à nouveau
            actives et votre chatbot est prêt à aider vos clients.
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section>
        <s-stack gap="base">
          <s-heading>Claude Chat Bot</s-heading>
          <s-paragraph>
            Votre assistant SAV intelligent tourne sur votre boutique. Il
            répond automatiquement aux questions des clients à partir de
            vos produits, politiques, pages et du contenu public de votre
            site.
          </s-paragraph>
          <s-paragraph>
            La base de connaissances est synchronisée automatiquement à
            chaque modification de vos produits. Vos données sont conservées
            30 jours après désinstallation : si vous réinstallez l&apos;app
            dans cette fenêtre, tout est restauré automatiquement.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Rétention des données" slot="aside">
        <s-paragraph>
          Après désinstallation, vos données (produits, conversations) sont
          conservées pendant <s-text emphasis="bold">30 jours</s-text> avant
          d&apos;être définitivement supprimées. Les tokens
          d&apos;authentification sont, eux, supprimés immédiatement pour
          des raisons de sécurité.
        </s-paragraph>
      </s-section>

      <s-section heading="Prochaines étapes" slot="aside">
        <s-text>
          Activez l&apos;extension de thème dans l&apos;éditeur de votre
          thème pour afficher le chat sur votre boutique.
        </s-text>
      </s-section>
    </s-page>
  );
}
