def get_user_data(user_id, api_key):
    # Restructured logic
    return {"id": user_id, "name": "Refactored User"}

def process_payment(user_id, amount):
    user = get_user_data(user_id)
    print(f"Processing ${amount} for {user['name']}")
    return True

def checkout(user_id, items):
    total = sum(item['price'] for item in items)
    if process_payment(user_id, total):
        print("Checkout successful")
