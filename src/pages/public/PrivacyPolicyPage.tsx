import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { APP_CONFIG } from "../../config/config";
import { IconLogo } from "../../components/ui";

const PrivacyPolicyPage: React.FC = () => {
  return (
    <div className="min-h-screen bg-bg">
      <nav className="border-b border-border sticky top-0 bg-white/95 backdrop-blur-sm z-40">
        <div className="container-custom">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center space-x-2">
              <IconLogo className="w-8 h-8 text-accent" />
              <span className="text-xl font-bold text-text">
                {APP_CONFIG.appName}
              </span>
            </Link>
            <Link
              to="/"
              className="text-text-secondary hover:text-text flex items-center transition-colors"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Home
            </Link>
          </div>
        </div>
      </nav>

      <main className="container-custom py-12 max-w-4xl">
        <div className="bg-white rounded-xl shadow-sm border border-border p-8 md:p-12">
          <h1 className="text-3xl font-bold text-text mb-4">Privacy Policy</h1>
          <p className="text-text-secondary mb-8 block">
            Last updated: {new Date().toLocaleDateString("en-IN", { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>

          <div className="prose prose-slate max-w-none text-text-secondary">
            <p className="mb-6">
              Welcome to {APP_CONFIG.appName} ("we," "our," or "us"). We are committed to protecting your personal information and your right to privacy. If you have any questions or concerns about this privacy notice or our practices regarding your personal information, please contact us.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">1. Information We Collect</h2>
            <p className="mb-4">
              <strong>Personal Information Provided by You:</strong> We collect names, phone numbers, email addresses, mailing addresses, billing addresses, passwords, and other similar information when you register on the platform.
            </p>
            <p className="mb-4">
              <strong>Restaurant Data:</strong> We collect details about your restaurant including FSSAI registration details (if applicable), menu items, pricing (including GST), business hours, and payment routing information.
            </p>
            <p className="mb-6">
              <strong>Customer Data:</strong> When end-customers use the QR code scanning to view menus and place orders, we may collect their device IP address, browser type, ordering preferences, and optionally their contact information if they choose to provide it for order tracking.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">2. How We Use Your Information</h2>
            <ul className="list-disc pl-6 mb-6 space-y-2">
              <li>To facilitate account creation and logon process.</li>
              <li>To provide and manage the Services provided to you (such as digital menus, order tracking, and table management).</li>
              <li>To fulfill and manage orders, payments, returns, and exchanges made through the platform.</li>
              <li>To send administrative information to you, including updates to our terms, conditions, and policies.</li>
              <li>To request feedback and to contact you about your use of our platform.</li>
              <li>To protect our Services (for example, fraud monitoring and prevention).</li>
            </ul>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">3. Legal Basis under Indian Law (DPDP Act)</h2>
            <p className="mb-6">
              In compliance with the Digital Personal Data Protection Act, 2023 (DPDPA) of India, we process your personal data based on your explicit consent, or for the legitimate performance of a contract (such as providing restaurant software services). You have the right to access, correct, or erase your data, as well as the right to withdraw your consent at any time.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">4. Data Sharing and Disclosure</h2>
            <p className="mb-6">
              We only share information with your consent, to comply with laws (including GST audits or legal requests from Indian authorities), to provide you with services, to protect your rights, or to fulfill business obligations. We do not sell your personal data to third-party advertisers. Payments are processed via secured, RBI-compliant third-party payment gateways.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">5. Data Retention and Security</h2>
            <p className="mb-6">
              We will only keep your personal information for as long as it is necessary for the purposes set out in this privacy notice, unless a longer retention period is required or permitted by law (such as tax, accounting, or other legal requirements like maintaining GST records). We have implemented appropriate technical and organizational security measures (including secure hosting via Supabase) designed to protect the security of any personal information we process.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">6. Contact Us</h2>
            <p className="mb-6">
              If you have questions or comments about this notice, you may email our Grievance Officer at <a href="mailto:support@rasoiqr.com" className="text-accent underline">support@rasoiqr.com</a>.
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t border-border py-8 mt-auto">
        <div className="container-custom text-center text-sm text-text-secondary">
          © {new Date().getFullYear()} {APP_CONFIG.appName}. All rights reserved.
        </div>
      </footer>
    </div>
  );
};

export default PrivacyPolicyPage;
