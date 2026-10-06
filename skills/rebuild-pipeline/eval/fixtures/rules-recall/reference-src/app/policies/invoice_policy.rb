class InvoicePolicy
  VOIDING_ROLES = %w[finance owner].freeze

  def initialize(user, invoice)
    @user = user
    @invoice = invoice
  end

  def update?
    @invoice.draft? && @user.account_id == @invoice.customer.account_id
  end

  def void?
    VOIDING_ROLES.include?(@user.role) && @invoice.payments.succeeded.none?
  end
end
