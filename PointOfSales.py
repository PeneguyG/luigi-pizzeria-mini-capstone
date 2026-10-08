'''
Point of Sales system
Developers: Grace Peneguy, Josseline Artola

'''
#Libraries imported
import sqlite3
import customtkinter as ctk

#Setting up the cursor to connect to sqlite3 database
conn = sqlite3.connect('Order_manager.db')
cursor = conn.cursor()

ctk.set_appearance_mode('light')
ctk.set_default_color_theme('green')

root = ctk.CTk()
root.title('Pizza Management Program')
root.geometry('1024x768')
root.resizable(False,False)
root.configure(fg_color='#A3CFA7')

'''
Login commands
'''
def main_program():
    '''
    Creating the tabs for the main program
    '''
    main_frame = ctk.CTkFrame(root, fg_color='#A3CFA7')
    main_frame.pack(fill=ctk.BOTH, expand=True)

    tabview = ctk.CTkTabview(main_frame, fg_color="#FBFBFB",segmented_button_fg_color="#F6C2C2", segmented_button_selected_hover_color="#4CA03B",segmented_button_unselected_color="#CFA3A3", text_color="black")
    tabview.pack(padx=20, pady=20, fill="both", expand=True)
                
    tabview.add("Point of Sales")
    tabview.add("Active Orders")
    tabview.add("All Orders")
    tabview.add("Sales Data")
    tabview.add("Logout" )

def login_confirmation():
    #Takes the 
    username = username_entry.get()
    password = password_entry.get()

    if username == "default" and password == "password123":
        login_frame.pack_forget()
        main_program()
    elif username =="luigi" and password == "mushroomkingdom83":
        login_frame.pack_forget()
        main_program()
    else:
        error_label.configure(text="Invalid username or password")

'''
Login Function and verification of authorized user
'''
#Creating the frame that holds the login
login_frame = ctk.CTkFrame(root, fg_color="#FFFFFF")
login_frame.pack(pady=50, padx=50, expand=True)

login_label = ctk.CTkLabel(login_frame, text="Welcome to Luigi's Pizzeria. Please login!", font=("Arial", 20, "bold"))
login_label.pack(pady=20, padx=10)

username_entry= ctk.CTkEntry(login_frame, placeholder_text="Username")
username_entry.pack(pady=20,padx=10)

password_entry= ctk.CTkEntry(login_frame, placeholder_text="Password")
password_entry.pack(pady=10,padx=10)

login_button= ctk.CTkButton(login_frame, fg_color='#A3CFA7', text ="Login", command=login_confirmation)
login_button.pack(pady=10, padx=10)

error_label = ctk.CTkLabel(login_frame, text="", text_color="red")
error_label.pack(pady=5, padx=5)


'''
Admin mainframe for Luigi
'''

root.mainloop()
