import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { APP_CONFIG } from "../../config/config";
import { IconLogo } from "../../components/ui";

const TermsOfServicePage: React.FC = () => {
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
          <h1 className="text-3xl font-bold text-text mb-4">Terms of Service</h1>
          <p className="text-text-secondary mb-8 block">
            Last updated: {new Date().toLocaleDateString("en-IN", { month: 'long', day: 'numeric', year: 'numeric' })}
          </p>

          <div className="prose prose-slate max-w-none text-text-secondary">
            <p className="mb-6">
              Welcome to {APP_CONFIG.appName}. These Terms of Service ("Terms") constitute a legally binding agreement made between you, whether personally or on behalf of an entity ("you" or "Restaurant Partner") and {APP_CONFIG.appName} ("company", "we", "us", or "our"), concerning your access to and use of our SaaS platform.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">1. Agreement to Terms</h2>
            <p className="mb-6">
              By accessing our platform, you agree that you have read, understood, and agreed to be bound by all of these Terms of Service. If you do not agree with all of these Terms, then you are expressly prohibited from using the platform and you must discontinue use immediately.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">2. Services and Account Registration</h2>
            <p className="mb-4">
              {APP_CONFIG.appName} provides a digital QR-based menu and ordering ecosystem for restaurants. To use full features, you must register for an account.
            </p>
            <ul className="list-disc pl-6 mb-6 space-y-2">
              <li>You agree to keep your password confidential and will be responsible for all use of your account and password.</li>
              <li>You represent that all registration information you submit will be true, accurate, current, and complete.</li>
              <li>You are responsible for uploading accurate menu items, descriptions, and adhering to all local food safety regulations, including displaying your FSSAI registration number if applicable.</li>
            </ul>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">3. Fees, Payments, and Taxes (GST)</h2>
            <p className="mb-6">
              You may be required to purchase or pay a fee to access some of our services. We bill you through an online billing account. All prices are in Indian Rupees (₹). 
              Where applicable, our fees will include the Goods and Services Tax (GST) at the prevailing rate (typically 5% or 18% depending on the exact service classification). You agree to provide current, complete, and accurate purchase and account information. You are solely responsible for calculating, collecting, and remitting any taxes (including GST on food orders) applicable to your end-customers' bills. {APP_CONFIG.appName} acts purely as a technology provider and is not responsible for your tax liabilities.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">4. User Representations and Legal Compliance</h2>
            <p className="mb-6">
              You agree to use the platform in compliance with all applicable local, state, national, and international laws, including consumer protection guidelines for e-commerce entities in India. You represent that your restaurant operates legally, serving items fit for human consumption and strictly adhering to food safety norms defined by the Food Safety and Standards Authority of India (FSSAI).
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">5. Disclaimer and Limitation of Liability</h2>
            <p className="mb-6">
              The site and services are provided on an as-is and as-available basis. We make no warranties or representations about the accuracy or completeness of the site's content. We will not be liable for any direct, indirect, consequential, exemplary, incidental, special, or punitive damages, including lost profit or lost revenue arising from your use of the site or failure of the service.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">6. Jurisdiction</h2>
            <p className="mb-6">
              These terms shall be governed by and defined following the laws of India. {APP_CONFIG.appName} and yourself irrevocably consent that the competent courts of India shall have exclusive jurisdiction to resolve any dispute which may arise in connection with these terms.
            </p>

            <h2 className="text-xl font-semibold text-text mt-8 mb-4">7. Contact Us</h2>
            <p className="mb-6">
              In order to resolve a complaint regarding the Site or to receive further information regarding use of the Site, please contact us at: <a href="mailto:support@rasoiqr.com" className="text-accent underline">support@rasoiqr.com</a>.
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

export default TermsOfServicePage;
